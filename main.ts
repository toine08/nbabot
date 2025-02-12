import { load } from "std/dotenv/mod.ts";
import { CronJob } from "cron";
import { BskyAgent } from "@atproto/api";
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

interface JsonData {
  East: string[];
  West: string[];
  games?: string[] | string;
  [key: string]: string[] | string | undefined;
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
  MAX_CHUNK_SIZE: 280, // Actual BlueSky limit
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
  private agent: BskyAgent;
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
    retries: number = CONFIG.RETRY.MAX_ATTEMPTS,
    delay: number = CONFIG.RETRY.INITIAL_DELAY
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (
        retries > 0 &&
        error instanceof Error &&
        error.message.includes("Rate Limit Exceeded")
      ) {
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

    const result = await this.retryWithBackoff(() =>
      this.agent.post({
        text: fullText,
        facets,
        reply: options.reply,
      })
    );
    return result;
  }

  async verifyAndPost(text: string, prefix = ""): Promise<void> {
    const splitter = new GraphemeSplitter();
    const maxContentLength = 300;

    if (splitter.countGraphemes(text) > maxContentLength) {
      console.log("Text is too long, splitting into multiple posts.");
      await this.createThread([text], prefix);
    } else {
      console.log("Text is within the limit, posting directly.");
      await this.postWithHashtag(text);
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
      const lines = list.split("\n");

      let currentChunk = [];
      let currentLength = 0;

      for (const line of lines) {
        const lineLength = splitter.countGraphemes(line);
        const effectiveMaxLength = maxContentLength;

        // If adding this line would exceed the limit, start a new chunk
        if (currentLength + lineLength > maxContentLength) {
          if (currentChunk.length > 0) {
            result.push(currentChunk.join("\n"));
            currentChunk = [];
            currentLength = 0;
          }

          if (lineLength > effectiveMaxLength) {
            const words = line.split(" ");
            let currentLine = "";
            for (const word of words) {
              const wordLength = splitter.countGraphemes(word + " ");
              if (
                splitter.countGraphemes(currentLine) + wordLength >
                effectiveMaxLength
              ) {
                if (currentLine) result.push(currentLine.trim());
                currentLine = word + " ";
              } else {
                currentLine += word + " ";
              }
            }
            if (currentLine) result.push(currentLine.trim());
          } else {
            currentChunk.push(line);
            currentLength = lineLength;
          }
        } else {
          currentChunk.push(line);
          currentLength += lineLength;
        }
      }

      if (currentChunk.length > 0) {
        result.push(currentChunk.join("\n"));
      }

      return result;
    };

    let processedChunks: string[] = [];
    for (const post of posts) {
      processedChunks = processedChunks.concat(splitLongList(post));
    }

    console.log("Thread chunks:");
    processedChunks.forEach((chunk, i) => {
      const length = splitter.countGraphemes(chunk + "\n" + CONFIG.HASHTAG);
      console.log(`Chunk ${i + 1}: ${length} chars`);
      if (length > CONFIG.MAX_POST_LENGTH) {
        console.error(`WARNING: Chunk ${i + 1} exceeds limit: ${length} chars`);
      }
    });

    for (const [index, chunk] of processedChunks.entries()) {
      const replyOptions: PostOptions =
        index > 0 && parentUri && parentCid
          ? {
              reply: {
                root: { uri: parentUri, cid: parentCid },
                parent: { uri: parentUri, cid: parentCid },
              },
            }
          : {};

      const response = await this.postWithHashtag(chunk, replyOptions);

      if (index === 0) {
        parentUri = response?.uri || null;
        parentCid = response?.cid || null;
      }
    }
  }

  async deleteAll(): Promise<void> {
    try {
      const profile = await this.agent.getProfile({ actor: this.agent.session?.did });
      const feed = await this.agent.getAuthorFeed({ actor: profile.data.did });
      
      for (const post of feed.data.feed) {
        if (post.post.uri) {
          await this.retryWithBackoff(() =>
            this.agent.deletePost(post.post.uri)
          );
          console.log(`Deleted post: ${post.post.uri}`);
          // Add small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      console.log("Finished deleting all posts");
    } catch (error) {
      console.error("Error deleting posts:", error);
      throw error;
    }
  }
}

// Data Manager
class DataManager {
  private decoder = new TextDecoder("utf-8");

  async readJsonFile(path: string): Promise<JsonData> {
    try {
      const scriptDir = new URL(".", import.meta.url).pathname;
      const fullPath = `${scriptDir}${path}`;
      console.log(`Reading file from: ${fullPath}`);

      const data = await Deno.readFile(fullPath);
      const jsonData = JSON.parse(this.decoder.decode(data));
      console.log(`Successfully read data from ${path}:`, jsonData);
      return jsonData;
    } catch (error) {
      console.error(`Error reading file ${path}:`, error);
      throw error;
    }
  }

  async getLastScores(): Promise<string[]> {
    try {
      const data = await this.readJsonFile("backend/last_games_score.json");
      console.log("Processing games data:", data);

      // Handle the case where data itself is an array
      if (Array.isArray(data)) {
        console.log("Data is an array of games");
        return data;
      }

      // Handle the legacy format where games are under a 'games' property
      if (data.games) {
        console.log("Data has 'games' property");
        const games = Array.isArray(data.games) ? data.games : [data.games];
        return this.splitText(games.join("\n"));
      }

      console.log("No valid games data found");
      return [];
    } catch (error) {
      console.error("Error getting last scores:", error);
      return [];
    }
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
    try {
      const data = await this.readJsonFile("./backend/future_games.json");
      console.log("Processing planned games data: ", data);

      if (Array.isArray(data)) {
        console.log("Data is an array of games");
        return data;
      }
      if (data.games) {
        console.log("Data has games property");
        const games = Array.isArray(data.games) ? data.games : [data.games];
        return this.splitText(games.join("\n"));
      }
      console.log("No valid games data found");
      return [];
    } catch (error) {
      console.error("Error getting planned games: ", error);
      return [];
    }
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
    try {
      const scriptDir = new URL(".", import.meta.url).pathname;
      const pythonScript = `${scriptDir}backend/main.py`;
      console.log(`Executing Python script: ${pythonScript}`);

      const command = new Deno.Command("python3", {
        args: [pythonScript],
      });
      const { stdout, stderr } = await command.output();
      console.log("Python script output:", new TextDecoder().decode(stdout));
      if (stderr.length > 0) {
        console.error(
          "Python script errors:",
          new TextDecoder().decode(stderr)
        );
      }
    } catch (error) {
      console.error("Error updating data:", error);
      throw error;
    }
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
      const description = "NBA Results from last night:\n\n";
      await this.bsky.createThread([description + posts[0], ...posts.slice(1)]);
      console.log(`[${new Date().toISOString()}] Posted last games results`);
    });
  }

  async postStandings(): Promise<void> {
    await this.state.withLock("standings", async () => {
      const standings = await this.data.getStandings();

      // Post Eastern Conference
      const eastDescription = "Eastern Conference Standings:\n\n";
      const eastChunks = this.splitArray(standings.east, 2);
      await this.bsky.createThread(
        [eastDescription + eastChunks[0].join("\n"), ...eastChunks.slice(1).map(chunk => chunk.join("\n"))]
      );

      // Small delay between conference posts
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Post Western Conference
      const westDescription = "Western Conference Standings:\n\n";
      const westChunks = this.splitArray(standings.west, 2);
      await this.bsky.createThread(
        [westDescription + westChunks[0].join("\n"), ...westChunks.slice(1).map(chunk => chunk.join("\n"))]
      );

      console.log(`[${new Date().toISOString()}] Posted standings`);
    });
  }

  async postPlannedGames(): Promise<void> {
    await this.state.withLock("plannedGames", async () => {
      const posts = await this.data.getFutureGames();
      const description = "🏀 Tonight's NBA Games:\n\n";
      await this.bsky.createThread([description + posts[0], ...posts.slice(1)]);
      console.log(`[${new Date().toISOString()}] Posted planned games`);
    });
  }

  // Add method to delete all posts
  async deleteAllPosts(): Promise<void> {
    await this.state.withLock("deleteAll", async () => {
      await this.bsky.deleteAll();
      console.log(`[${new Date().toISOString()}] Deleted all posts`);
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

    // Perform initial data update
    console.log("Performing initial data update...");
    await dataManager.updateData();
    console.log("Initial data update completed");

    // Schedule jobs
    new CronJob(CONFIG.SCHEDULES.DATA_UPDATE, () =>
      dataManager.updateData()
    ).start();
    new CronJob(CONFIG.SCHEDULES.LAST_GAMES, () =>
      postManager.postLastGames()
    ).start();
    new CronJob(CONFIG.SCHEDULES.STANDINGS, () =>
      postManager.postStandings()
    ).start();

    new CronJob(CONFIG.SCHEDULES.PLANNED_GAMES, () =>
      postManager.postPlannedGames()
    ).start();
    new CronJob(CONFIG.SCHEDULES.TEST, async () => {
      await postManager.postLastGames();
      //await postManager.postPlannedGames();
      //await postManager.postStandings();
    }).start();
    console.log("NBA Bot started successfully!");
    //await postManager.deleteAllPosts();
  } catch (error) {
    console.error("Failed to start NBA Bot:", error);
    Deno.exit(1);
  }
}

// Start the application
main();



