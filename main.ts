// import dotenv
import { load } from "std/dotenv/mod.ts";
import GraphemeSplitter from "npm:grapheme-splitter";
import { CronJob } from "cron";
// import Bluesky agent
import api from "@atproto/api";
const { BskyAgent } = api;

// load .env file
const env = await load({
  defaultsPath: null,
  restrictEnvAccessTo: ["BLUESKY_IDENTIFIER", "BLUESKY_PASSWORD"],
});

let dailyParentPostId: string | "";
// get identifier and password from .env
const IDENTIFIER = env["BLUESKY_IDENTIFIER"];
const PASSWORD = env["BLUESKY_PASSWORD"];


// create an agent
const agent = new BskyAgent({
  service: "https://bsky.social",
});

// Retry mechanism with exponential backoff
async function retryWithBackoff(fn: () => Promise<any>, retries: number = 5, delay: number = 1000): Promise<any> {
  try {
    return await fn();
  } catch (error:any ) {
    if (retries > 0 && error?.message?.includes("Rate Limit Exceeded")) {
      console.log(`Rate limit exceeded. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    } else {
      throw error;
    }
  }
}

// login to the client with retry mechanism
await retryWithBackoff(() => agent.login({
  identifier: IDENTIFIER,
  password: PASSWORD,
}));

async function get_last_scores(): Promise<string> {
  const decoder = new TextDecoder("utf-8");
  const data = await Deno.readFile("./backend/last_games_score.json");
  const jsonString = decoder.decode(data);
  const games = JSON.parse(jsonString);

  let resultText = "";
  for (const game of games) {
    resultText += `${game}\n`;
  }
  return resultText;
}

async function get_standings(): Promise<{ east: string[], west: string[] }> {
  const decoder = new TextDecoder("utf-8");
  const data = await Deno.readFile("./backend/standing.json");
  const jsonString = decoder.decode(data);
  const ranking = JSON.parse(jsonString);

  const east_standing = ranking.East.map((team: string, index: number) => `${index + 1}. ${team}`);
  const west_standing = ranking.West.map((team: string, index: number) => `${index + 1}. ${team}`);

  return { east: east_standing, west: west_standing };
}

async function get_future_games(): Promise<string> {
  const decoder = new TextDecoder("utf-8");
  const data = await Deno.readFile("./backend/future_games.json");
  const jsonString = decoder.decode(data);
  const games = JSON.parse(jsonString);
  let futurGames = ""

  for(const game of games){
    futurGames += `${game}\n` 
  }
  return futurGames
}

function getCurrentTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace('T', ' ').split('.')[0];
}

async function create_post_last_games() {
  const splitter = new GraphemeSplitter();
  const splited_post: string[] = [];
  const lastGamesScore = await get_last_scores();
  const resultOfTheNight = "Results of the night: ";
  const maxContentLength = 300 - resultOfTheNight.length - 1 - 5; // Reserve space for "\n" and "#NBA"

  let start = 0;

  while (start < lastGamesScore.length) {
    let end = start + maxContentLength;
    const substring = lastGamesScore.slice(start, end);

    const graphemeCount = splitter.splitGraphemes(substring).length;

    if (graphemeCount <= maxContentLength) {
      const splitIndex = lastGamesScore.lastIndexOf("\n--", end);
      if (splitIndex > start && splitIndex !== -1) {
        end = splitIndex; // End the chunk at "\n--"
      }
    }

    splited_post.push(lastGamesScore.slice(start, end).trim());
    start = end + 4; // Skip over "\n--" for the next start
  }

  let dailyParentPostId: string ="";
  let rootUri: string = "";
  let parentUri: string = "";
  let rootCid: string = "";
  let parentCid: string = "";

  for (const [index, post] of splited_post.entries()) {
    if (index === 0) {
      // Post the first message and save its postId (URI) and CID
      const firstPostResponse = await agent.post({
        text: `${resultOfTheNight}\n${post}\n #NBA`,
      });

      // Extract the URI and CID for root and parent
      dailyParentPostId = firstPostResponse?.uri || "";
      rootUri = dailyParentPostId;
      parentUri = dailyParentPostId; 

      rootCid = firstPostResponse?.cid || ""; 
      parentCid = rootCid; // For the first reply, parentCID is the same as rootCID

      console.log(`First post created with URI: ${dailyParentPostId}, CID: ${rootCid}`);
    } else {
      // Post replies in the thread
      if (dailyParentPostId !== "" && rootCid !== "" && parentCid !== "") {
        await agent.post({
          text: `${post}\n#NBA`,
          reply: {
            root: {
              uri: rootUri,
              cid: rootCid, // Use the correct cid from the response
            },
            parent: {
              uri: parentUri,
              cid: parentCid, // Use the correct cid from the response
            }
          },
        });

        // Update parent URI and CID for the next reply
        parentUri = dailyParentPostId;
        parentCid = rootCid; // For replies, the parent CID remains the same as the root CID
      } else {
        console.error("No parent post ID or CID found, cannot continue thread.");
        break;
      }
    }
  }

  console.log(`Thread posted successfully at ${getCurrentTimestamp()}!`);
}

async function create_post_standings() {
  const standings = await get_standings();

  const splitAndPost = async (conference: string, standings: string[]) => {
    let parentUri: string | null = null;
    let parentCid: string | null = null;

    const half = Math.ceil(standings.length / 2);
    const chunks = [standings.slice(0, half), standings.slice(half)];

    for (const chunk of chunks) {
      const postText = `${conference} Standings:\n${chunk.join('\n')}\n #NBA`;

      const postResponse = await agent.post({
        text: postText,
        reply: parentUri && parentCid ? {
          root: {
            uri: parentUri,
            cid: parentCid,
          },
          parent: {
            uri: parentUri,
            cid: parentCid,
           }
        } : undefined,
      });

      parentUri = postResponse?.uri || null;
      parentCid = postResponse?.cid || null;

      console.log(`[${getCurrentTimestamp()}]Posted:: ${postText}`, postText.length);
    }
  };

  await splitAndPost("Eastern Conference", standings.east);
  await splitAndPost("Western Conference", standings.west);
}

const MAX_POST_LENGTH = 300; // Adjust this value based on the actual maximum length allowed

async function create_post_planned_games() {
  const plannedGames = await get_future_games();

  if (plannedGames.length <= MAX_POST_LENGTH) {
    // Post the entire plannedGames content as a single post
    const firstPostResponse = await agent.post({
      text: `Tonight's games: \n${plannedGames}`,
    });

    const dailyParentPostId = firstPostResponse?.uri || "";
    const rootCid = firstPostResponse?.cid || "";

    console.log(`First post created with URI: ${dailyParentPostId}, CID: ${rootCid}`);
  } else {
    // Split the plannedGames content into multiple posts
    const splited_post = splitText(plannedGames, MAX_POST_LENGTH);
    console.log(splited_post)

    let dailyParentPostId = "";
    let rootUri = "";
    let parentUri = "";
    let rootCid = "";
    let parentCid = "";

    for (const [index, post] of splited_post.entries()) {
      if (index === 0) {
        // Post the first message and save its postId (URI) and CID
        const firstPostResponse = await agent.post({
          text: `Tonight's game: \n${post}`,
        });

        // Extract the URI and CID for root and parent
        dailyParentPostId = firstPostResponse?.uri || "";
        rootUri = dailyParentPostId;
        parentUri = dailyParentPostId;

        rootCid = firstPostResponse?.cid || "";
        parentCid = rootCid; // For the first reply, parentCID is the same as rootCID

        console.log(`First post created with URI: ${dailyParentPostId}, CID: ${rootCid}`);
      } else {
        // Post replies in the thread
        if (dailyParentPostId !== "" && rootCid !== "" && parentCid !== "") {
          await agent.post({
            text: `${post}\n#NBA`,
            reply: {
              root: {
                uri: rootUri,
                cid: rootCid, // Use the correct cid from the response
              },
              parent: {
                uri: parentUri,
                cid: parentCid, // Use the correct cid from the response
              },
            },
          });

          // Update parent URI and CID for the next reply
          parentUri = dailyParentPostId;
          parentCid = rootCid; // For replies, the parent CID remains the same as the root CID
        } else {
          console.error("No parent post ID or CID found, cannot continue thread.");
          break;
        }
      }
    }
    console.log(`[${getCurrentTimestamp()}] Thread posted successfully!`);
  }
}

function splitText(text: string, maxLength: number): string[] {
  const result = [];
  let current = "";

  for (const word of text.split(" ")) {
    if ((current + word).length > maxLength) {
      result.push(current.trim());
      current = "";
    }
    current += word + " ";
  }

  if (current.trim().length > 0) {
    result.push(current.trim());
  }

  return result;
}

async function updateData(){
  const command = new Deno.Command('python3', {
    args: [ "./backend/main.py" ],
  });
  const { stdout, stderr } = await command.output();
  console.log(new TextDecoder().decode(stdout));
  console.log(new TextDecoder().decode(stderr));
}


const scheduleExpressionMinute = "* * * * *"; // Run once every minute for testing
const scheduleExpression = "0 7 * * *"; // Run once every three hours in prod
const scheduleExpressionMondayMorning = "0 8 * * 1";
const scheduleExpressionEveryDayAt18 = "0 18 * * *"
const scheduleExpressionRetreiveData = "10 */4 * * *"
const retreiveData = new CronJob(scheduleExpressionRetreiveData, updateData);
const last_games = new CronJob(scheduleExpression, create_post_last_games); // change to scheduleExpressionMinute for testing
const standings = new CronJob(scheduleExpressionMondayMorning, create_post_standings);
const planned_games = new CronJob(scheduleExpressionEveryDayAt18, create_post_planned_games)


retreiveData.start()
last_games.start()
standings.start()
planned_games.start()



const testCronJob = new CronJob(scheduleExpressionMinute, async () => {
  await create_post_planned_games();
});
//testCronJob.start()


// Function to delete all posts
async function deleteAllPosts() {
  try {
    console.log("Fetching all posts...");

    // Fetch the user's posts
    const feed = await agent.getAuthorFeed({
      actor: IDENTIFIER, // User's DID or handle
      limit: 100, // Adjust the limit as necessary
    });

    if (!feed.data.feed.length) {
      console.log("No posts to delete.");
      return;
    }

    for (const post of feed.data.feed) {
      const { uri } = post.post; // Full URI of the post
      const rkey = uri.split("/").pop(); // Extract the rkey (record key)

      console.log(`Deleting post: ${uri}`);

      // Delete the post
      await agent.com.atproto.repo.deleteRecord({
        repo: IDENTIFIER, // User's DID
        collection: "app.bsky.feed.post", // Post collection
        rkey: rkey!, // The record key extracted from the URI
      });

      console.log(`Successfully deleted post: ${uri}`);
    }

    console.log("All posts deleted successfully!");
  } catch (error) {
    console.error("Error deleting posts:", error);
  }
}
//await deleteAllPosts();
