import * as cheerio from "cheerio";
import fs from "fs";
import { writeFile, mkdir, readFile } from "fs/promises";
import fetch from "node-fetch";
import pLimit from "p-limit";
import * as XLSX from 'xlsx';

let config: Config | undefined;
try {
  config = require("./config.json");
  console.log("Config loaded successfully");
} catch (error) {
  console.log("config.json file not found or invalid.");
}

// Interfaces for project configuration
interface Project {
  topic: string;
  url: string;
  disabled?: boolean;
}

interface Config {
  users: Record<string, User>;
}

interface User {
  projects: Project[];
}

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
];


function getRequestOptions (){
  var agentIndex = Math.floor(Math.random() * userAgents.length);
  var userAgent = userAgents[agentIndex];
  return {
    method: "GET",
    redirect: "follow" as RequestRedirect,
    headers: {
      "User-Agent": userAgent,
      Referer: "https://www.yad2.co.il/",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
      "Cache-Control": "max-age=0",
      "Connection": "keep-alive",
      "DNT": "1",
      "Sec-Fetch-Dest": 'document',
      "Sec-Fetch-Mode": 'navigate',      
    },
    cookies: {
      '__ssds': '3',
      'y2018-2-cohort': '88',
      'use_elastic_search': '1',
      'abTestKey': '2',
      'cohortGroup': 'D'
    }
  }
};

// Utility functions
// Function to fetch HTML response from Yad2 with retry mechanism, backoff strategy, and maximum timeout
const getYad2Response = async (url: string, retriesLeft = 4, maxTimeout = 60000): Promise<string> => {
  // console.log(`Fetching URL: ${url}, Retries left: ${retries}`);
  const maxRetries = retriesLeft;
  const backoffDelay = (attempt: number) => Math.pow(2, attempt) * 1000; // Exponential backoff in milliseconds
  const startTime = Date.now();

  while (retriesLeft > 0) {
    try {
      // Check if maximum timeout is reached
      if (Date.now() - startTime > maxTimeout) {
        console.error("Maximum timeout reached, aborting retries");
        throw new Error("Maximum timeout reached while trying to fetch URL");
      }
      const requestOptions = getRequestOptions();
      const res = await fetch(url, requestOptions);
      if (!res.ok) {
        console.error(`Fetch failed with status: ${res.status} ${res.statusText}`);
        throw new Error(`Failed to fetch Yad2: ${res.status} ${res.statusText}`);
      }
      // console.log(`Successfully fetched URL: ${url}`);

      var htmlRes = await res.text();
      const $ = cheerio.load(htmlRes);

      const titleText = $("title").first().text();
      console.log(`Page title: ${titleText}`);
      if (titleText === "ShieldSquare Captcha") {
        const errorMsg = `Bot detection encountered, agent used: ${requestOptions.headers["User-Agent"]}`
        console.error(errorMsg);
        throw new Error(errorMsg);
      }

      return htmlRes;
    } catch (err) {
      retriesLeft -= 1;
      if (retriesLeft === 0) {
        throw new Error(''+err);
      }
      const delay = backoffDelay(maxRetries - retriesLeft);
      console.log(`Retrying... (${retriesLeft} attempts left, waiting for ${delay}ms)`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Failed to fetch Yad2 response");
};

// Function to extract ad details from Yad2 HTML response
const scrapeItemsAndExtractAdDetails = async (url: string): Promise<any[]> => {
  console.log(`Scraping items from URL: ${url}`);
  const yad2Html = await getYad2Response(url);
  const $ = cheerio.load(yad2Html);

  const possibleSelectors = ["[data-testid='item-basic']"];
  let $feedItems;

  for (const selector of possibleSelectors) {
    $feedItems = $(selector);
    if ($feedItems.length) {
      break;
    }
  }

  if (!$feedItems || !$feedItems.length) {
    console.log("No more ads found - reached end of listings");
    return [];
  }

  const adDetails: Record<string, string>[] = [];
  $feedItems.each((_, elm) => {
    const imageUrl = $(elm).find("img[data-testid='image']").attr("src");
    const address = $(elm).find("[class^=item-data-content_heading]").eq(1).text().trim();
    const description = $(elm).find("[class^='item-data-content_itemInfoLine']").first().text().trim();
    const structure = $(elm).find("[class^=item-data-content_itemInfoLine]").eq(1).text().trim();
    const price = $(elm).find("span[data-testid='price']").text().trim();
    const relativeLink = $(elm).find('a[class^="item-layout_itemLink"]').attr("href");

    // Extract floor, rooms, and square meters from structure
    const structureText = structure.toLowerCase();
    let floor = "";
    let rooms = "";
    let squareMeters = "";

    // Extract floor
    const floorMatch = structureText.match(/קומה\s*(\d+)/);
    if (floorMatch) {
      floor = floorMatch[1];
    }

    // Extract rooms
    const roomsMatch = structureText.match(/(\d+(?:\.5)?)\s*חדרים/);
    if (roomsMatch) {
      rooms = roomsMatch[1];
    }

    // Extract square meters
    const metersMatch = structureText.match(/(\d+)\s*מ"ר/);
    if (metersMatch) {
      squareMeters = metersMatch[1];
    }

    let fullLink = "";
    if (relativeLink) {
      const baseUrl = "https://www.yad2.co.il";
      fullLink = `${baseUrl}${relativeLink}`;
    }

    adDetails.push({
      fullLink: fullLink || "",
      imageUrl: imageUrl || "",
      address,
      description,
      floor,
      rooms,
      squareMeters,
      price,
      structure
    });
  });

  console.log(`Extracted details for ${adDetails.length} ads`);
  return adDetails;
};

// Function to save data to Excel
const saveToExcel = async (ads: any[], topic: string): Promise<void> => {
  console.log(`Saving ${ads.length} ads to Excel for topic: ${topic}`);
  
  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(ads);
  
  // Add worksheet to workbook
  XLSX.utils.book_append_sheet(wb, ws, topic);
  
  // Create data directory if it doesn't exist
  if (!fs.existsSync("data")) {
    await mkdir("data", { recursive: true });
  }
  
  // Write to file
  const fileName = `./data/${topic}_${new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, fileName);
  console.log(`Data saved to ${fileName}`);
};

// Function to check for new items and update saved items list
const checkForNewItems = async (ads: any[], topic: string, user: User): Promise<any[]> => {
  console.log(`Checking for new items for topic: ${topic}`);
  const filePath = `./data/${topic}.json`;
  let savedAds = new Set<string>();

  try {
    if (fs.existsSync(filePath)) {
      const data = await readFile(filePath, "utf-8");
      try {
        savedAds = new Set(JSON.parse(data));
        console.log(`Loaded ${savedAds.size} saved ads for topic: ${topic}`);
      } catch (parseError) {
        console.error("Error parsing saved ads, reverting to empty set", parseError);
        savedAds = new Set<string>();
        // Optionally create a backup of the corrupted file
        await writeFile(`${filePath}.backup`, data);
        console.log(`Backup of corrupted data saved to ${filePath}.backup`);
      }
    } else {
      console.log(`Data file for topic ${topic} does not exist. Creating new file.`);
      if (!fs.existsSync("data")) {
        await mkdir("data", { recursive: true });
      }
      await writeFile(filePath, "[]");
    }
  } catch (e) {
    console.error("Error accessing saved ads", e);
    throw new Error(`Could not read or create ${filePath}`);
  }

  const newItems = ads.filter((ad) => !savedAds.has(ad.imageUrl));
  console.log(`Found ${newItems.length} new items for topic: ${topic}`);
  if (newItems.length > 0) {
    newItems.forEach((ad) => savedAds.add(ad.imageUrl));
    await writeFile(filePath, JSON.stringify(Array.from(savedAds), null, 2));
    console.log(`Updated saved ads for topic: ${topic}`);
    await saveToExcel(newItems, topic);
  }
  return newItems;
};

// Function to create a push flag for CI/CD pipeline
const createPushFlagForWorkflow = async (): Promise<void> => {
  console.log("Creating push flag for CI/CD pipeline");
  await writeFile("push_me", "");
};

// Function to perform scraping and save to Excel
const scrape = async (topic: string, url: string, user: User): Promise<void> => {
  console.log(`Starting scrape for topic: ${topic}`);
  try {
    let allAds: any[] = [];
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      const pageUrl = `${url}&page=${page}`;
      console.log(`Scraping page ${page} from URL: ${pageUrl}`);
      const ads = await scrapeItemsAndExtractAdDetails(pageUrl);
      if (ads.length === 0) {
        hasMorePages = false;
      } else {
        allAds = allAds.concat(ads);
        page++;
      }
    }

    console.log(`Total ads scraped: ${allAds.length}`);
    const newItems = await checkForNewItems(allAds, topic, user);
    if (newItems.length > 0) {
      console.log(`Found ${newItems.length} new items for topic: ${topic}`);
      await createPushFlagForWorkflow();
    } else {
      console.log(`No new items found for topic: ${topic}`);
    }
  } catch (error) {
    console.error(`Error scraping topic ${topic}:`, error);
    throw error;
  }
};

// Main function to iterate through all projects and perform scraping
const main = async (userToScrape: string, topic: string): Promise<void> => {
  console.log("Starting main scraping process");
  console.log(`Scraping for user: ${userToScrape}, topic: ${topic}`);

  if (!config) {
    throw new Error("Configuration not found");
  }

  const user = config.users[userToScrape];
  if (!user) {
    throw new Error(`User ${userToScrape} not found in configuration`);
  }

  const limit = pLimit(3); // Limit concurrent requests to 3
  const scrapePromises: Promise<void>[] = [];

  if (topic) {
    const project = user.projects.find((p) => p.topic === topic);
    if (project && !project.disabled) {
      console.log(`Adding topic "${topic}" to scraping queue`);
      scrapePromises.push(limit(() => scrape(topic, project.url, user)));
    }
  } else {
    user.projects.forEach((project) => {
      if (!project.disabled) {
        console.log(`Adding topic "${project.topic}" to scraping queue`);
        scrapePromises.push(limit(() => scrape(project.topic, project.url, user)));
      }
    });
  }

  await Promise.all(scrapePromises);
  console.log("Completed all scraping tasks");
};

// Run the scraper
main("default_user", "neot_rachel_sales").catch((error) => {
  console.error("Error in main process:", error);
  process.exit(1);
});
