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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY not set');
  process.exit(1);
}

// Valid month names for validation
const VALID_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

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

IMPORTANT: Start your response with this exact marker on the first line:
<!-- BEST_MONTHS: Month1, Month2, Month3 -->
Replace Month1, Month2, Month3 with the actual best months to visit ${country.name} (use full month names like January, February, etc.). List 2-5 months.

REQUIREMENTS:
- 2,500-3,500 words
- Write in first person as Elena Vasquez, senior travel editor
- Warm, authoritative, helpful tone
- Target keyword: "best time to visit ${country.name}"
- Use the keyword naturally 4-6 times throughout the article

STRUCTURE (use these exact H2 headings):
## At a Glance
(Quick-reference table in markdown format with these rows: Best Months, Avg Temp, Peak Season, Budget Level, Currency.
Then 1 paragraph, 3-4 sentences, directly answering when is the best time to visit ${country.name} and why.)

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
Write exactly 5 FAQs in this exact format:
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

REFERENCES SECTION:
After the FAQ section, provide 5-7 country-specific authoritative references in this exact format:
<!-- REFS_START -->
- [Title of source](URL) - Brief description of what this source covers
- [Title of source](URL) - Brief description of what this source covers
<!-- REFS_END -->

Use ONLY real, verifiable URLs from these types of sources:
- Official tourism board of ${country.name}
- CIA World Factbook page for ${country.name}
- National weather/meteorological service
- UNESCO World Heritage pages relevant to ${country.name}
- Lonely Planet ${country.name} overview
- U.S. Department of State travel advisory for ${country.name}
- World Health Organization travel advice

IMPORTANT: Write ONLY the article content. Do NOT include any markdown frontmatter. Start directly with the <!-- BEST_MONTHS marker.`;
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

// Parse references from REFS markers in the article content
function parseReferences(content) {
  const refsMatch = content.match(/<!-- REFS_START -->([\s\S]*?)<!-- REFS_END -->/);
  if (!refsMatch) return [];

  const refsText = refsMatch[1];
  const refs = [];
  // Match lines like: - [Title](URL) - Description
  const linePattern = /- \[([^\]]+)\]\(([^)]+)\)\s*[-–—]\s*(.+)/g;
  let match;

  while ((match = linePattern.exec(refsText)) !== null) {
    refs.push({
      title: match[1].trim(),
      url: match[2].trim(),
      description: match[3].trim(),
    });
  }

  return refs;
}

// Extract "best months" from the BEST_MONTHS marker, with regex fallback
function extractBestMonths(content, countryName) {
  // Try the explicit marker first
  const markerMatch = content.match(/<!-- BEST_MONTHS:\s*(.+?)\s*-->/);
  if (markerMatch) {
    const months = markerMatch[1].trim();
    // Validate it actually contains month names
    const hasRealMonths = VALID_MONTHS.some(m => months.includes(m));
    if (hasRealMonths) return months;
  }

  // Fallback: regex extraction from prose
  const monthsPattern = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const monthCapture = `((?:${monthsPattern})(?:\\s*(?:to|through|and|,|-)\\s*(?:${monthsPattern}))*)`;

  const patterns = [
    new RegExp(`best (?:time|months?) (?:to visit|for)[^.]*?(?:is|are)\\s+${monthCapture}`, 'i'),
    new RegExp(`(?:visit|go)[^.]*?(?:between|during|from|in)\\s+${monthCapture}`, 'i'),
    new RegExp(`(?:ideal|perfect|optimal)[^.]*?${monthCapture}`, 'i'),
  ];
  for (const pat of patterns) {
    const m = content.match(pat);
    if (m) return m[1].trim();
  }
  return 'Varies by region';
}

// Build Hugo frontmatter + content
function buildMarkdown(country, countryData, articleContent, faqs, heroImage, climateChart) {
  const year = new Date().getFullYear();
  const now = new Date().toISOString();
  const bestMonths = extractBestMonths(articleContent, country.name);
  const references = parseReferences(articleContent);

  // Clean markers from article body (FAQ, REFS, BEST_MONTHS)
  const cleanContent = articleContent
    .replace(/<!-- BEST_MONTHS:.*?-->\n?/, '')
    .replace(/<!-- FAQ_START -->[\s\S]*?<!-- FAQ_END -->/, '')
    .replace(/<!-- REFS_START -->[\s\S]*?<!-- REFS_END -->/, '')
    .trim();

  // Build frontmatter
  const faqYaml = faqs.map(f =>
    `  - question: "${f.question.replace(/"/g, '\\"')}"\n    answer: "${f.answer.replace(/"/g, '\\"')}"`
  ).join('\n');

  const relatedYaml = (countryData.related || []).map(r => `  - "${r}"`).join('\n');

  // Build references YAML
  const refsYaml = references.map(r =>
    `  - title: "${r.title.replace(/"/g, '\\"')}"\n    url: "${r.url}"\n    description: "${r.description.replace(/"/g, '\\"')}"`
  ).join('\n');

  // Pre-compute image paths (avoid regex inside template literals)
  const heroPath = heroImage && heroImage.path ? heroImage.path.replace(/^\//, '') : '';
  const heroAlt = (heroImage && heroImage.alt) ? heroImage.alt : (country.name + ' travel destination');
  const heroCredit = (heroImage && heroImage.credit) ? heroImage.credit : '';
  const chartPath = climateChart ? climateChart.replace(/^\//, '') : '';

  const frontmatter = `---
title: "Best Time to Visit ${country.name} (${year} Guide)"
slug: "best-time-to-visit-${country.slug}"
date: "${now}"
lastmod: "${now}"
description: "Discover the best time to visit ${country.name}. Month-by-month weather guide, top activities by season, and expert travel tips from Elena Vasquez."
country_name: "${country.name}"
region: "${countryData.region}"
best_months: "${bestMonths}"
hero_image: "${heroPath}"
hero_alt: "${heroAlt}"
hero_credit: "${heroCredit}"
climate_chart: "${chartPath}"
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
references:
${refsYaml}
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

    // Step 2: Generate/fetch hero image (Gemini Nano Banana -> Pexels -> Unsplash)
    let heroImage = null;
    const imageApiKey = GEMINI_API_KEY || PEXELS_API_KEY;
    if (imageApiKey) {
      console.log('--- Step 2: Generating hero image ---');
      heroImage = await fetchHeroImage(entry.name, entry.slug, imageApiKey);
      console.log('');
    } else {
      console.log('--- Step 2: Skipping hero image (no GEMINI_API_KEY or PEXELS_API_KEY) ---\n');
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

    // Step 4: Parse FAQs, references, and build markdown
    console.log('--- Step 4: Building Hugo markdown ---');
    const faqs = parseFAQs(articleContent);
    console.log(`Parsed ${faqs.length} FAQ items`);

    const refs = parseReferences(articleContent);
    console.log(`Parsed ${refs.length} references`);

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
    console.log(`References: ${refs.length}`);
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
