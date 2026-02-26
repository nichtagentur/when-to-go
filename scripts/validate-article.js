#!/usr/bin/env node

// Quality validation script - checks articles before publishing
// Run: node scripts/validate-article.js [slug]
// Without argument, validates all generated articles

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'content', 'countries');

// --- Validation thresholds ---
const MIN_WORDS = 1400;
const MAX_WORDS = 5000;
const REQUIRED_FAQ_COUNT = 5;
const MIN_REFERENCES = 3;
const MAX_DESCRIPTION_LENGTH = 160;

// The 6 core H2 sections every article must have
const REQUIRED_H2S = [
  'At a Glance',
  'Month-by-Month',
  'Activities',
  'Peak Season',
  'Regional Climate',
  'Budget Tips',
];

// Valid month names
const VALID_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Valid regions
const VALID_REGIONS = [
  'Africa', 'Asia', 'Caribbean', 'Central America',
  'Europe', 'Middle East', 'North America', 'Oceania', 'South America',
];

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

  // --- ERROR checks (must pass) ---

  // 1. Word count minimum
  const words = body.split(/\s+/).filter(w => w.length > 0).length;
  if (words < MIN_WORDS) errors.push(`Too short: ${words} words (min ${MIN_WORDS})`);
  if (words > MAX_WORDS) warnings.push(`Very long: ${words} words (max ${MAX_WORDS})`);

  // 2. best_months must contain real month names
  const bestMonthsMatch = frontmatter.match(/best_months:\s*"(.+?)"/);
  if (bestMonthsMatch) {
    const bestMonthsValue = bestMonthsMatch[1];
    const hasRealMonth = VALID_MONTHS.some(m => bestMonthsValue.includes(m));
    if (!hasRealMonth) {
      errors.push(`best_months "${bestMonthsValue}" does not contain valid month names (Jan-Dec)`);
    }
  } else {
    errors.push('Missing best_months in frontmatter');
  }

  // 3. Required H2 sections (partial match)
  for (const section of REQUIRED_H2S) {
    const regex = new RegExp(`^##.*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im');
    if (!regex.test(body)) {
      errors.push(`Missing required section containing "${section}"`);
    }
  }

  // 4. FAQ count must be exactly 5
  const faqCount = (frontmatter.match(/- question:/g) || []).length;
  if (faqCount !== REQUIRED_FAQ_COUNT) {
    errors.push(`Expected ${REQUIRED_FAQ_COUNT} FAQs, found ${faqCount}`);
  }

  // --- WARNING checks (should pass, but won't block) ---

  // 5. References in frontmatter (at least 3)
  const refCount = (frontmatter.match(/- title:/g) || []).length;
  if (refCount < MIN_REFERENCES) {
    warnings.push(`Only ${refCount} references in frontmatter (recommend ${MIN_REFERENCES}+)`);
  }

  // 6. Climate chart file exists on disk (check root and static/)
  const chartMatch = frontmatter.match(/climate_chart:\s*"(.+?)"/);
  if (chartMatch && chartMatch[1]) {
    const chartPath = path.join(ROOT, chartMatch[1]);
    const chartPathStatic = path.join(ROOT, 'static', chartMatch[1]);
    if (!fs.existsSync(chartPath) && !fs.existsSync(chartPathStatic)) {
      warnings.push(`Climate chart file not found: ${chartMatch[1]}`);
    }
  }

  // 7. Hero image file exists on disk (check root and static/)
  const heroMatch = frontmatter.match(/hero_image:\s*"(.+?)"/);
  if (heroMatch && heroMatch[1]) {
    const heroPath = path.join(ROOT, heroMatch[1]);
    const heroPathStatic = path.join(ROOT, 'static', heroMatch[1]);
    if (!fs.existsSync(heroPath) && !fs.existsSync(heroPathStatic)) {
      warnings.push(`Hero image file not found: ${heroMatch[1]}`);
    }
  } else {
    warnings.push('No hero image set');
  }

  // 8. Region is one of the 9 valid regions
  const regionMatch = frontmatter.match(/region:\s*"(.+?)"/);
  if (regionMatch) {
    if (!VALID_REGIONS.includes(regionMatch[1])) {
      warnings.push(`Region "${regionMatch[1]}" is not one of: ${VALID_REGIONS.join(', ')}`);
    }
  }

  // 9. Description under 160 characters
  const descMatch = frontmatter.match(/description:\s*"(.+?)"/);
  if (descMatch && descMatch[1].length > MAX_DESCRIPTION_LENGTH) {
    warnings.push(`Description is ${descMatch[1].length} chars (max ${MAX_DESCRIPTION_LENGTH})`);
  }

  // 10. TourRadar URL in frontmatter
  if (!frontmatter.includes('tourradar_url:') || frontmatter.includes('tourradar_url: ""')) {
    warnings.push('No tourradar_url in frontmatter');
  }

  // 11. Target keyword count
  const countryMatch = frontmatter.match(/country_name:\s*"(.+?)"/);
  if (countryMatch) {
    const keyword = `best time to visit ${countryMatch[1]}`.toLowerCase();
    const keywordCount = (body.toLowerCase().match(new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (keywordCount < 2) warnings.push(`Keyword "${keyword}" only appears ${keywordCount} times (target: 4-6)`);
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
