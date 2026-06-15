import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const config = JSON.parse(readFileSync(resolve(__dirname, "../config.json"), "utf-8"));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;

async function runSql(query: string): Promise<any> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ sql: query }),
  });
  return response.json();
}

async function deploySqlFile(filename: string, name: string): Promise<void> {
  console.log(`Deploying ${name}...`);
  const sql = readFileSync(resolve(__dirname, filename), "utf-8");
  
  // Split by semicolon and execute each statement
  const statements = sql
    .split(/;?\s*\n\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
  
  for (const stmt of statements) {
    if (!stmt || stmt.startsWith('--')) continue;
    const result = await runSql(stmt);
    if (result.error) {
      console.log(`  ⚠️ ${result.error.substring(0, 100)}`);
    } else {
      console.log(`  ✅ OK`);
    }
  }
}

async function main() {
  console.log("=== DEPLOYING DATA QUALITY DASHBOARD ===\n");
  
  // Step 1: Dashboard Views
  await deploySqlFile("01_dashboard_views.sql", "Dashboard Views");
  
  // Step 2: Source Tiers
  await deploySqlFile("02_source_tiers.sql", "Source Tiers");
  
  // Step 3: Reject Log Table
  await deploySqlFile("03c_reject_log.sql", "Reject Log Table");
  
  // Step 4: Low Relevance Table
  await deploySqlFile("04b_low_relevance_schema.sql", "Low Relevance Table");
  
  // Verify
  console.log("\n=== VERIFYING DEPLOYMENT ===\n");
  
  const views = await runSql(`
    SELECT table_name FROM information_schema.views 
    WHERE table_schema = 'central' 
    AND table_name LIKE 'v_l1_%'
    ORDER BY table_name
  `);
  
  console.log("Dashboard Views:");
  for (const v of views.data || []) {
    console.log(`  ✅ central.${v.table_name}`);
  }
  
  const tables = await runSql(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'central' 
    AND table_name LIKE 'l1_%'
    ORDER BY table_name
  `);
  
  console.log("\nQuality Tables:");
  for (const t of tables.data || []) {
    console.log(`  ✅ central.${t.table_name}`);
  }
  
  // Test queries
  console.log("\n=== TESTING VIEWS ===\n");
  
  const summary = await runSql(`SELECT * FROM central.v_l1_quality_summary`);
  console.log("v_l1_quality_summary:");
  console.log(JSON.stringify(summary.data, null, 2));
}

main().catch(console.error);
