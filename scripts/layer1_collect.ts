/**
 * VECTX V3 - Layer 1 Collect Script
 * 
 * Fetches RSS feeds from drivers_sources and stores events in drivers_events
 * Uses Supabase Edge Function for database access
 * No LLM required - pure data collection
 */

import RSSParser from 'rss-parser';

// Config
const SUPABASE_URL = 'https://umjerckgospmifikdrli.supabase.co';
const ADMIN_TOKEN = 'dndhbhdn9848nd9834nd';

const rssParser = new RSSParser({
  timeout: 30000,
  headers: {
    'User-Agent': 'VectX/3.0 RSS Collector',
  },
});

interface Source {
  id: string;
  asset_id: string;
  asset_name: string;
  driver_id: string;
  driver_name: string;
  name: string;
  url: string;
  trust_score: number;
}

async function runSql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
    },
    body: JSON.stringify({ sql: query, params }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SQL error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.data || [];
}

async function getActiveSources(): Promise<Source[]> {
  const query = `
    SELECT 
      id, asset_id, asset_name, driver_id, driver_name, 
      name, url, trust_score
    FROM central.drivers_sources
    WHERE active = true AND auto_analyze = true
  `;
  return runSql<Source>(query);
}

async function getRecentHeadlines(driverId: string, hoursBack: number = 24): Promise<Set<string>> {
  const query = `
    SELECT headline 
    FROM central.drivers_events
    WHERE driver_id = $1 
    AND created_at >= NOW() - INTERVAL '${hoursBack} hours'
  `;
  const rows = await runSql<{ headline: string }>(query, [driverId]);
  return new Set(rows.map(r => r.headline));
}

async function insertEvents(
  source: Source,
  items: { title: string; link: string; content: string }[]
): Promise<number> {
  if (items.length === 0) return 0;

  const values = items.map((_, i) => {
    const base = i * 8;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
  }).join(', ');

  const params: unknown[] = [];
  for (const item of items) {
    params.push(
      source.asset_id,
      source.asset_name,
      source.driver_id,
      source.driver_name,
      source.id,
      source.name,
      item.title,
      item.content  // contentSnippet/content, not link
    );
  }

  const query = `
    INSERT INTO central.drivers_events 
      (asset_id, asset_name, driver_id, driver_name, source_id, source_name, headline, output)
    VALUES ${values}
  `;

  await runSql(query, params);
  return items.length;
}

async function updateSourceStatus(
  sourceId: string,
  result: 'success' | 'error',
  errorMsg?: string
): Promise<void> {
  const query = errorMsg
    ? `UPDATE central.drivers_sources 
       SET last_fetch = NOW(), last_result = $2, error_count = error_count + 1, last_error = $3
       WHERE id = $1`
    : `UPDATE central.drivers_sources 
       SET last_fetch = NOW(), last_result = $2
       WHERE id = $1`;

  const params = errorMsg 
    ? [sourceId, result, errorMsg]
    : [sourceId, result];

  await runSql(query, params);
}

async function fetchRSSFeed(url: string): Promise<{ title: string; link: string; content: string }[]> {
  try {
    const feed = await rssParser.parseURL(url);
    return feed.items
      .filter(item => item.title && item.link)
      .map(item => ({
        title: item.title!,
        link: item.link!,
        // Use contentSnippet/content if available, otherwise fall back to title (not URL!)
        content: item.contentSnippet || item.content || (item as any).description || item.title!,
      }))
      .slice(0, 50);
  } catch (error) {
    throw error;
  }
}

// Batch processing - only process specified assets
const BATCH_ASSETS = process.env.ASSETS?.split(',') || null;

async function collect() {
  console.log('=== VECTX V3 - Layer 1 Collect ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  // Get all active sources
  let sources: Source[];
  try {
    sources = await getActiveSources();
    // Filter by batch if specified
    if (BATCH_ASSETS) {
      sources = sources.filter(s => BATCH_ASSETS.includes(s.asset_name));
      console.log(`BATCH MODE: Processing only ${BATCH_ASSETS.join(', ')}`);
    }
  } catch (error) {
    console.error('Error fetching sources:', error);
    console.log('\nNOTE: Check that the Edge Function "run-sql" is deployed and the admin token is correct.');
    return { error: 'Failed to fetch sources' };
  }

  console.log(`Found ${sources.length} active sources`);
  console.log('');

  if (sources.length === 0) {
    console.log('No active sources found. Check database.');
    return { sourcesProcessed: 0, errors: 0, newEvents: 0 };
  }

  let totalNewEvents = 0;
  let successCount = 0;
  let errorCount = 0;

  // Group sources by driver for efficient deduplication
  const sourcesByDriver = new Map<string, Source[]>();
  for (const source of sources) {
    if (!sourcesByDriver.has(source.driver_id)) {
      sourcesByDriver.set(source.driver_id, []);
    }
    sourcesByDriver.get(source.driver_id)!.push(source);
  }

  // Process each driver
  for (const [driverId, driverSources] of sourcesByDriver) {
    const driverName = driverSources[0].driver_name;
    const assetName = driverSources[0].asset_name;
    
    console.log(`\n[${assetName}] ${driverName}`);
    console.log(`  Sources: ${driverSources.length}`);

    // Get recent headlines for deduplication
    const recentHeadlines = await getRecentHeadlines(driverId);
    console.log(`  Recent headlines: ${recentHeadlines.size}`);

    // Process each source for this driver
    for (const source of driverSources) {
      process.stdout.write(`  Fetching: ${source.name.substring(0, 40)}... `);
      
      try {
        const items = await fetchRSSFeed(source.url);
        process.stdout.write(`${items.length} items, `);

        // Filter out duplicates
        const newItems = items.filter(item => !recentHeadlines.has(item.title));
        
        if (newItems.length > 0) {
          const inserted = await insertEvents(source, newItems);
          totalNewEvents += inserted;
          console.log(`${newItems.length} new, ${inserted} inserted`);
        } else {
          console.log('0 new');
        }

        // Update source status
        await updateSourceStatus(source.id, 'success');
        successCount++;

        // Add to recent headlines to prevent duplicates within this run
        newItems.forEach(item => recentHeadlines.add(item.title));

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`ERROR: ${errorMsg.substring(0, 60)}`);
        await updateSourceStatus(source.id, 'error', errorMsg);
        errorCount++;
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Sources processed: ${successCount} success, ${errorCount} errors`);
  console.log(`Total new events: ${totalNewEvents}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return {
    sourcesProcessed: successCount,
    errors: errorCount,
    newEvents: totalNewEvents,
  };
}

// Run
collect().catch(console.error);