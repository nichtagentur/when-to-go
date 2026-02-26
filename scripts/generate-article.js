#!/usr/bin/env node

// Main article generation script
// Picks next country from queue, generates content + images, creates Hugo markdown

const fs = require('fs');
const path = require('path');
const { generateContent } = require('./lib/openrouter.js');
const { fetchHeroImage } = require('./lib/pexels.js');
const { generateClimateChart } = require('./lib/openai-images.js');

// Config
const ROOT = path.join(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'data', 'queue.json');
const COUNTRIES_PATH = path.join(ROOT, 'data', 'countries.json');
const CONTENT_DIR = path.join(ROOT, 'content', 'countries');

// Required environment variables
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY not set');
  process.exit(1);
}

// Load data files
function loadQueue() {
  return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

function loadCountries() {
  return JSON.parse(fs.readFileSync(COUNTRIES_PATH, 'utf-8'));
}

// Pick next country to generate
function getNextCountry(queue) {
  // Allow targeting a specific country via CLI argument
  const targetSlug = process.argv[2];
  if (targetSlug) {
    const entry = queue.find(q => q.slug === targetSlug);
    if (entry) return entry;
    console.error(`Country "${targetSlug}" not found in queue`);
    process.exit(1);
  }

  // Otherwise pick next pending (tier 1 first, already sorted)
  return queue.find(q => q.status === 'pending');
}

// Build the AI prompt for article generation
function buildPrompt(country, countryData) {
  const year = new Date().getFullYear();
  const relatedNames = (countryData.related || [])
    .map(slug => {
      const c = loadCountries().find(c => c.slug === slug);
      return c ? c.name : slug;
    })
    .join(', ');

  return `Write a comprehensive travel guide titled "Best Time to Visit ${country.name} (${year} Guide)".

REQUIREMENTS:
- 2,500-3,500 words
- Write in first person as Elena Vasquez, senior travel editor
- Warm, authoritative, helpful tone
- Target keyword: "best time to visit ${country.name}"
- Use the keyword naturally 4-6 times throughout the article

STRUCTURE (use these exact H2 headings):
## Overview: Why Visit ${country.name}?
(2-3 paragraphs about what makes this country special)

## Month-by-Month Weather Guide
(Cover all 12 months with temperature, rainfall, and what to expect. Use a markdown table with columns: Month | Temperature | Rainfall | Crowds | Rating)

## Best Time for Popular Activities
(H3 subheadings for 4-6 activities specific to this country, e.g., hiking, beaches, festivals, wildlife)

## Peak Season vs. Shoulder Season vs. Off-Season
(Compare the three periods with pros/cons of each)

## Regional Climate Differences
(Different areas of the country may have different best times)

## What to Pack
(Season-specific packing advice)

## Budget Tips by Season
(How costs vary throughout the year)

## Getting There and Around
(Brief transport overview, best times for cheaper flights)

TOURRADAR MENTION:
Include one natural mention like: "For a hassle-free way to explore ${country.name}, consider a guided multi-day tour through [TourRadar](https://www.tourradar.com/d/${countryData.tourradar_slug}), which bundles accommodation, transport, and expert local guides."

RELATED DESTINATIONS:
Briefly mention these nearby alternatives: ${relatedNames}

FAQ SECTION:
At the very end, write exactly 5 FAQs in this exact format:
<!-- FAQ_START -->
Q: What is the best month to visit ${country.name}?
A: [Answer]

Q: Is ${country.name} worth visiting in the rainy season?
A: [Answer]

Q: How far in advance should I book a trip to ${country.name}?
A: [Answer]

Q: What is the cheapest time to visit ${country.name}?
A: [Answer]

Q: Is ${country.name} safe to visit?
A: [Answer]
<!-- FAQ_END -->

IMPORTANT: Write ONLY the article content. Do NOT include any markdown frontmatter. Start directly with the ## Overview heading.`;
}

// Parse FAQ items from the article content
function parseFAQs(content) {
  const faqMatch = content.match(/<!-- FAQ_START -->([\s\S]*?)<!-- FAQ_END -->/);
  if (!faqMatch) return [];

  const faqText = faqMatch[1];
  const faqs = [];
  const pairs = faqText.split(/\n\s*Q:\s*/);

  for (const pair of pairs) {
    if (!pair.trim()) continue;
    const parts = pair.split(/\n\s*A:\s*/);
    if (parts.length >= 2) {
      faqs.push({
        question: parts[0].replace(/^\s*Q:\s*/, '').trim(),
        answer: parts[1].trim(),
      });
    }
  }

  return faqs;
}

// Extract "best months" summary from the content
function extractBestMonths(content, countryName) {
  // Try to find a clear best-month statement
  const patterns = [
    /best (?:time|months?) (?:to visit|for).*?(?:is|are)\s+([A-Z][a-z]+(?:\s+(?:to|through|and|,)\s+[A-Z][a-z]+)*)/i,
    /(?:visit|go).*?(?:between|during|in)\s+([A-Z][a-z]+(?:\s+(?:to|through|and|,)\s+[A-Z][a-z]+)*)/i,
  ];
  for (const pat of patterns) {
    const m = content.match(pat);
    if (m) return m[1];
  }
  return 'Varies by region';
}

// Build Hugo frontmatter + content
function buildMarkdown(country, countryData, articleContent, faqs, heroImage, climateChart) {
  const year = new Date().getFullYear();
  const now = new Date().toISOString();
  const bestMonths = extractBestMonths(articleContent, country.name);

  // Clean FAQ markers from article body
  const cleanContent = articleContent
    .replace(/<!-- FAQ_START -->[\s\S]*?<!-- FAQ_END -->/, '')
    .trim();

  // Build frontmatter
  const faqYaml = faqs.map(f =>
    `  - question: "${f.question.replace(/"/g, '\\"')}"\n    answer: "${f.answer.replace(/"/g, '\\"')}"`
  ).join('\n');

  const relatedYaml = (countryData.related || []).map(r => `  - "${r}"`).join('\n');

  const frontmatter = `---
title: "Best Time to Visit ${country.name} (${year} Guide)"
slug: "best-time-to-visit-${country.slug}"
date: "${now}"
lastmod: "${now}"
description: "Discover the best time to visit ${country.name}. Month-by-month weather guide, top activities by season, and expert travel tips from Elena Vasquez."
country_name: "${country.name}"
region: "${countryData.region}"
best_months: "${bestMonths}"
hero_image: "${heroImage?.path || ''}"
hero_alt: "${heroImage?.alt || country.name + ' travel destination'}"
hero_credit: "${heroImage?.credit || ''}"
climate_chart: "${climateChart || ''}"
tourradar_url: "https://www.tourradar.com/d/${countryData.tourradar_slug}"
keywords:
  - "best time to visit ${country.name}"
  - "when to go to ${country.name}"
  - "${country.name} weather"
  - "${country.name} travel guide"
related_countries:
${relatedYaml}
faq:
${faqYaml}
---

${cleanContent}`;

  return frontmatter;
}

// Main execution
async function main() {
  console.log('=== When To Go Article Generator ===\n');

  const queue = loadQueue();
  const countries = loadCountries();

  // Pick next country
  const entry = getNextCountry(queue);
  if (!entry) {
    console.log('All countries have been generated!');
    process.exit(0);
  }

  const countryData = countries.find(c => c.slug === entry.slug);
  if (!countryData) {
    console.error(`Country data not found for slug: ${entry.slug}`);
    process.exit(1);
  }

  console.log(`Generating article for: ${entry.name} (Tier ${entry.tier})\n`);

  // Update queue status
  entry.status = 'generating';
  saveQueue(queue);

  try {
    // Step 1: Generate article content via AI
    console.log('--- Step 1: Generating article content ---');
    const prompt = buildPrompt(entry, countryData);
    const { content: articleContent, model } = await generateContent(prompt, OPENROUTER_API_KEY);
    console.log(`Article generated with ${model} (${articleContent.length} chars)\n`);

    // Step 2: Fetch hero image from Pexels
    let heroImage = null;
    if (PEXELS_API_KEY) {
      console.log('--- Step 2: Fetching hero image ---');
      heroImage = await fetchHeroImage(entry.name, entry.slug, PEXELS_API_KEY);
      console.log('');
    } else {
      console.log('--- Step 2: Skipping hero image (no PEXELS_API_KEY) ---\n');
    }

    // Step 3: Generate climate chart
    let climateChart = null;
    if (OPENAI_API_KEY) {
      console.log('--- Step 3: Generating climate chart ---');
      climateChart = await generateClimateChart(entry.name, entry.slug, OPENAI_API_KEY);
      console.log('');
    } else {
      console.log('--- Step 3: Skipping climate chart (no OPENAI_API_KEY) ---\n');
    }

    // Step 4: Parse FAQs and build markdown
    console.log('--- Step 4: Building Hugo markdown ---');
    const faqs = parseFAQs(articleContent);
    console.log(`Parsed ${faqs.length} FAQ items`);

    const markdown = buildMarkdown(entry, countryData, articleContent, faqs, heroImage, climateChart);

    // Write article file
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
    const filePath = path.join(CONTENT_DIR, `${entry.slug}.md`);
    fs.writeFileSync(filePath, markdown);
    console.log(`Written to: ${filePath}\n`);

    // Update queue
    entry.status = 'generated';
    entry.generatedAt = new Date().toISOString();
    entry.error = null;
    saveQueue(queue);

    // Summary
    const pending = queue.filter(q => q.status === 'pending').length;
    console.log('=== Done! ===');
    console.log(`Country: ${entry.name}`);
    console.log(`Model: ${model}`);
    console.log(`FAQs: ${faqs.length}`);
    console.log(`Hero image: ${heroImage ? 'Yes' : 'No'}`);
    console.log(`Climate chart: ${climateChart ? 'Yes' : 'No'}`);
    console.log(`Remaining: ${pending} countries`);

  } catch (err) {
    console.error(`\nFailed to generate article for ${entry.name}: ${err.message}`);
    entry.status = 'failed';
    entry.error = err.message;
    saveQueue(queue);
    process.exit(1);
  }
}

main();
