#!/usr/bin/env node

// Quality validation script - checks articles before publishing
// Run: node scripts/validate-article.js [slug]
// Without argument, validates all generated articles

const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, '..', 'content', 'countries');
const MIN_WORDS = 1500;
const MAX_WORDS = 5000;
const REQUIRED_H2S = ['Overview', 'Month-by-Month', 'Activities', 'Season'];
const MIN_FAQS = 3;

function validateArticle(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const slug = path.basename(filePath, '.md');
  const errors = [];
  const warnings = [];

  // Split frontmatter and body
  const parts = content.split('---');
  if (parts.length < 3) {
    errors.push('Missing or malformed frontmatter');
    return { slug, errors, warnings, pass: false };
  }

  const frontmatter = parts[1];
  const body = parts.slice(2).join('---');

  // Check word count
  const words = body.split(/\s+/).filter(w => w.length > 0).length;
  if (words < MIN_WORDS) errors.push(`Too short: ${words} words (min ${MIN_WORDS})`);
  if (words > MAX_WORDS) warnings.push(`Very long: ${words} words (max ${MAX_WORDS})`);

  // Check required H2 sections (partial match)
  for (const section of REQUIRED_H2S) {
    const regex = new RegExp(`^##.*${section}`, 'im');
    if (!regex.test(body)) {
      warnings.push(`Missing section containing "${section}"`);
    }
  }

  // Check for target keyword
  const countryMatch = frontmatter.match(/country_name:\s*"(.+?)"/);
  if (countryMatch) {
    const keyword = `best time to visit ${countryMatch[1]}`.toLowerCase();
    const keywordCount = (body.toLowerCase().match(new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (keywordCount < 2) warnings.push(`Keyword "${keyword}" only appears ${keywordCount} times (target: 4-6)`);
  }

  // Check TourRadar link
  if (!body.includes('tourradar.com')) {
    warnings.push('No TourRadar link found in body (CTA partial handles this, OK if intentional)');
  }

  // Check FAQ in frontmatter
  const faqCount = (frontmatter.match(/- question:/g) || []).length;
  if (faqCount < MIN_FAQS) {
    warnings.push(`Only ${faqCount} FAQs (recommend ${MIN_FAQS}+)`);
  }

  // Check hero image reference
  if (!frontmatter.includes('hero_image:') || frontmatter.includes('hero_image: ""')) {
    warnings.push('No hero image set');
  }

  const pass = errors.length === 0;
  return { slug, words, errors, warnings, pass };
}

// Main
const targetSlug = process.argv[2];

if (targetSlug) {
  const filePath = path.join(CONTENT_DIR, `${targetSlug}.md`);
  if (!fs.existsSync(filePath)) {
    console.error(`Article not found: ${filePath}`);
    process.exit(1);
  }
  const result = validateArticle(filePath);
  printResult(result);
  process.exit(result.pass ? 0 : 1);
} else {
  // Validate all
  if (!fs.existsSync(CONTENT_DIR)) {
    console.log('No articles to validate yet.');
    process.exit(0);
  }

  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'));
  if (files.length === 0) {
    console.log('No articles to validate yet.');
    process.exit(0);
  }

  let allPass = true;
  console.log(`Validating ${files.length} articles...\n`);

  for (const file of files) {
    const result = validateArticle(path.join(CONTENT_DIR, file));
    printResult(result);
    if (!result.pass) allPass = false;
  }

  console.log(`\n${allPass ? 'ALL PASSED' : 'SOME FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

function printResult(result) {
  const status = result.pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${result.slug} (${result.words || '?'} words)`);
  for (const err of result.errors) console.log(`  ERROR: ${err}`);
  for (const warn of result.warnings) console.log(`  WARN: ${warn}`);
}
