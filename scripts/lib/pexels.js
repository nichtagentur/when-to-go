// Pexels API - fetches free landscape hero photos for countries
// Free tier: 200 requests/hour

const fs = require('fs');
const path = require('path');

async function fetchHeroImage(countryName, slug, apiKey) {
  const imageDir = path.join(__dirname, '../../static/images/countries', slug);
  const imagePath = path.join(imageDir, 'hero.jpg');

  // Skip if already exists
  if (fs.existsSync(imagePath)) {
    console.log(`Hero image already exists for ${countryName}`);
    return `/images/countries/${slug}/hero.jpg`;
  }

  // Try progressively broader search terms
  const searchTerms = [
    `${countryName} landscape travel`,
    `${countryName} scenery`,
    `${countryName}`,
  ];

  for (const query of searchTerms) {
    try {
      console.log(`Pexels: searching "${query}"...`);
      const response = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`,
        {
          headers: { 'Authorization': apiKey },
        }
      );

      if (!response.ok) {
        throw new Error(`Pexels returned ${response.status}`);
      }

      const data = await response.json();
      if (!data.photos || data.photos.length === 0) continue;

      // Pick the first high-quality landscape photo
      const photo = data.photos[0];
      const imageUrl = photo.src.large2x || photo.src.large;

      // Download the image
      console.log(`Downloading hero image for ${countryName}...`);
      const imgResponse = await fetch(imageUrl);
      if (!imgResponse.ok) throw new Error(`Failed to download image`);

      const buffer = Buffer.from(await imgResponse.arrayBuffer());
      fs.mkdirSync(imageDir, { recursive: true });
      fs.writeFileSync(imagePath, buffer);

      console.log(`Saved hero image for ${countryName} (${buffer.length} bytes)`);
      return {
        path: `/images/countries/${slug}/hero.jpg`,
        credit: `${photo.photographer} via Pexels`,
        alt: `${countryName} landscape - ${photo.alt || 'travel destination'}`,
      };
    } catch (err) {
      console.error(`Pexels search "${query}" failed: ${err.message}`);
    }
  }

  console.warn(`No hero image found for ${countryName}`);
  return null;
}

module.exports = { fetchHeroImage };
