import { load } from "std/dotenv/mod.ts";
import { CronJob } from "cron";
import api from "@atproto/api";
const { BskyAgent } = api;
import GraphemeSplitter from "npm:grapheme-splitter";
// Types
interface PostOptions {
  reply?: {
    root: { uri: string; cid: string };
    parent: { uri: string; cid: string };
  };
}

interface PostResponse {
  uri?: string;
  cid?: string;
}

interface Standings {
  east: string[];
  west: string[];
}

// Configuration
const CONFIG = {
  MAX_POST_LENGTH: 300,
  HASHTAG: "#nba",
  SCHEDULES: {
    DATA_UPDATE: "30 * * * *", // Every 30 minutes
    LAST_GAMES: "0 7 * * *", // Daily at 7 AM
    STANDINGS: "0 8 * * 1", // Mondays at 8 AM
    PLANNED_GAMES: "0 18 * * *", // Daily at 6 PM
    TEST: "* * * * *",
  },
  RETRY: {
    MAX_ATTEMPTS: 5,
    INITIAL_DELAY: 1000,
  },
} as const;

// State management
class PostingState {
  private static instance: PostingState;
  private isPosting = false;
  private lastPostTime: Record<string, number> = {};

  private constructor() {}

  static getInstance(): PostingState {
    if (!PostingState.instance) {
      PostingState.instance = new PostingState();
    }
    return PostingState.instance;
  }

  async withLock<T>(
    operation: string,
    fn: () => Promise<T>
  ): Promise<T | null> {
    const now = Date.now();
    const lastPost = this.lastPostTime[operation];

    // Prevent duplicate posts within 5 minutes
    if (lastPost && now - lastPost < 5 * 60 * 1000) {
      console.log(`Skipping ${operation}: too soon since last post`);
      return null;
    }

    if (this.isPosting) {
      console.log(`Skipping ${operation}: another post operation in progress`);
      return null;
    }

    this.isPosting = true;
    try {
      const result = await fn();
      this.lastPostTime[operation] = now;
      return result;
    } finally {
      this.isPosting = false;
    }
  }
}

// BlueSky Agent Manager
class BlueSkyManager {
  private agent: typeof BskyAgent;
  private state: PostingState;

  constructor() {
    this.agent = new BskyAgent({
      service: "https://bsky.social",
    });
    this.state = PostingState.getInstance();
  }

  async initialize(): Promise<void> {
    const env = await load({
      defaultsPath: null,
      restrictEnvAccessTo: ["BLUESKY_IDENTIFIER", "BLUESKY_PASSWORD"],
    });

    await this.retryWithBackoff(() =>
      this.agent.login({
        identifier: env["BLUESKY_IDENTIFIER"],
        password: env["BLUESKY_PASSWORD"],
      })
    );
  }

  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    retries = CONFIG.RETRY.MAX_ATTEMPTS,
    delay = CONFIG.RETRY.INITIAL_DELAY
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (retries > 0 && error?.message?.includes("Rate Limit Exceeded")) {
        console.log(`Rate limit exceeded. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.retryWithBackoff(fn, retries - 1, delay * 2);
      }
      throw error;
    }
  }

  async postWithHashtag(
    postText: string,
    options: PostOptions = {}
  ): Promise<PostResponse> {
    const fullText = `${postText}\n${CONFIG.HASHTAG}`;
    const facets = [
      {
        index: {
          byteStart: fullText.length - CONFIG.HASHTAG.length,
          byteEnd: fullText.length,
        },
        features: [
          {
            $type: "app.bsky.richtext.facet#tag",
            tag: "nba",
          },
        ],
      },
    ];

    return this.retryWithBackoff(() =>
      this.agent.post({
        text: fullText,
        facets,
        ...options,
      })
    );
  }

  async verifyAndPost(text: string, options: PostOptions = {}): Promise<void> {
    const splitter = new GraphemeSplitter();
    const maxContentLength = 300;
  
    if (splitter.countGraphemes(text) > maxContentLength) {
      console.log("Text is too long, splitting into multiple posts.");
      await this.createThread([text], options);
    } else {
      console.log("Text is within the limit, posting directly.");
      await this.postWithHashtag(text, options);
    }
  }
  
  async createThread(posts: string[], prefix = ""): Promise<void> {
    const splitter = new GraphemeSplitter();
    const maxContentLength = 300 - splitter.countGraphemes(prefix);
    let parentUri: string | null = null;
    let parentCid: string | null = null;
  
    // Custom splitting function to handle long lists more aggressively
    const splitLongList = (list: string): string[] => {
      const result: string[] = [];
      const lines = list.split('\n');
      
      let currentChunk = [];
      let currentLength = 0;
  
      for (const line of lines) {
        // If adding this line would exceed the limit, start a new chunk
        if (currentLength + splitter.countGraphemes(line) > maxContentLength) {
          result.push(currentChunk.join('\n'));
          currentChunk = [];
          currentLength = 0;
        }
        
        currentChunk.push(line);
        currentLength += splitter.countGraphemes(line);
      }
  
      // Add the last chunk if not empty
      if (currentChunk.length > 0) {
        result.push(currentChunk.join('\n'));
      }
  
      return result;
    };
  
    // Split each post separately to handle long standings lists
    const processedChunks: string[] = [];
    for (const post of posts) {
      const postChunks = splitLongList(post);
      processedChunks.push(...postChunks);
    }
  
    console.log(`Splitted chunks: ${processedChunks}`);
    for (const [index, chunk] of processedChunks.entries()) {
      console.log(`Chunk ${index + 1}: ${chunk}`);
    }
  
    // Create a post for each chunk
    for (const [index, chunk] of processedChunks.entries()) {
      const text = `${prefix}${chunk}`;
      const options: PostOptions = index > 0 && parentUri && parentCid
        ? {
            reply: {
              root: { uri: parentUri, cid: parentCid },
              parent: { uri: parentUri, cid: parentCid },
            },
          }
        : {};
  
      const response = await this.postWithHashtag(text, options);
  
      if (index === 0) {
        parentUri = response?.uri || null;
        parentCid = response?.cid || null;
      }
    }
  }
}

// Data Manager
class DataManager {
  private decoder = new TextDecoder("utf-8");

  async readJsonFile(path: string): Promise<any> {
    const data = await Deno.readFile(path);
    return JSON.parse(this.decoder.decode(data));
  }

  async getLastScores(): Promise<string[]> {
    const games = await this.readJsonFile("./backend/last_games_score.json");
    return this.splitText(games.join("\n"));
  }

  async getStandings(): Promise<Standings> {
    const ranking = await this.readJsonFile("./backend/standing.json");
    return {
      east: ranking.East.map(
        (team: string, index: number) => `${index + 1}. ${team}`
      ),
      west: ranking.West.map(
        (team: string, index: number) => `${index + 1}. ${team}`
      ),
    };
  }

  async getFutureGames(): Promise<string[]> {
    const games = await this.readJsonFile("./backend/future_games.json");
    return this.splitText(games.join("\n"));
  }

  private splitText(text: string): string[] {
    const chunks: string[] = [];
    let currentChunk = "";

    for (const line of text.split("\n")) {
      if ((currentChunk + line + "\n").length > CONFIG.MAX_POST_LENGTH) {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = line + "\n";
      } else {
        currentChunk += line + "\n";
      }
    }

    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    return chunks;
  }

  async updateData(): Promise<void> {
    const command = new Deno.Command("python3", {
      args: ["./backend/main.py"],
    });
    const { stdout, stderr } = await command.output();
    console.log(new TextDecoder().decode(stdout));
    console.error(new TextDecoder().decode(stderr));
  }
}

// Post Manager
class PostManager {
  private bsky: BlueSkyManager;
  private data: DataManager;
  private state: PostingState;

  constructor() {
    this.bsky = new BlueSkyManager();
    this.data = new DataManager();
    this.state = PostingState.getInstance();
  }

  async initialize(): Promise<void> {
    await this.bsky.initialize();
  }

  async postLastGames(): Promise<void> {
    await this.state.withLock("lastGames", async () => {
      const posts = await this.data.getLastScores();
      await this.bsky.createThread(posts, "Results of the night:\n");
      console.log(`[${new Date().toISOString()}] Posted last games results`);
    });
  }

  async postStandings(): Promise<void> {
    await this.state.withLock("standings", async () => {
      const standings = await this.data.getStandings();

      // Post Eastern Conference
      const eastChunks = this.splitArray(standings.east, 2);
      await this.bsky.createThread(
        eastChunks.map((chunk) => chunk.join("\n")),
        "Eastern Conference Standings:\n"
      );

      // Post Western Conference
      const westChunks = this.splitArray(standings.west, 2);
      await this.bsky.createThread(
        westChunks.map((chunk) => chunk.join("\n")),
        "Western Conference Standings:\n"
      );

      console.log(`[${new Date().toISOString()}] Posted standings`);
    });
  }

  async postPlannedGames(): Promise<void> {
    await this.state.withLock("plannedGames", async () => {
      const posts = await this.data.getFutureGames();
      await this.bsky.createThread(posts, "Tonight's games:\n");
      console.log(`[${new Date().toISOString()}] Posted planned games`);
    });
  }

  private splitArray<T>(array: T[], parts: number): T[][] {
    const chunkSize = Math.ceil(array.length / parts);
    return Array.from({ length: parts }, (_, i) =>
      array.slice(i * chunkSize, (i + 1) * chunkSize)
    );
  }
}

// Main application
async function main() {
  try {
    const postManager = new PostManager();
    await postManager.initialize();
    const dataManager = new DataManager();

    //Schedule jobs
    new CronJob(CONFIG.SCHEDULES.DATA_UPDATE, () => dataManager.updateData()).start();
    new CronJob(CONFIG.SCHEDULES.LAST_GAMES, () => postManager.postLastGames()).start();
    new CronJob(CONFIG.SCHEDULES.STANDINGS, () => postManager.postStandings()).start();
    new CronJob(CONFIG.SCHEDULES.PLANNED_GAMES, () => postManager.postPlannedGames()).start();
    /*
   new CronJob(CONFIG.SCHEDULES.TEST, () =>
      //postManager.postLastGames(),
      //postManager.postPlannedGames(),
      //postManager.postStandings(),

    ).start();*/
    console.log("NBA Bot started successfully!");
  } catch (error) {
    console.error("Failed to start NBA Bot:", error);
    Deno.exit(1);
  }
}

// Start the application
main();
