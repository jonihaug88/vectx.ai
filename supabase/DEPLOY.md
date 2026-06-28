# Deploying the Stufe-A Edge Function

## Option 1: Supabase Dashboard (Recommended for PoC)

1. Go to: https://supabase.com/dashboard/project/umjerckgospmifikdrli/edge-functions
2. Click "New Function"
3. Name: `driver-weighting-stufe-a`
4. Copy the contents of `supabase/functions/driver-weighting-stufe-a/index.ts`
5. Click "Deploy"

## Set Secrets

After deploying, set the required secrets:

1. Go to: Edge Functions → driver-weighting-stufe-a → Secrets
2. Add:
   - `GEMINI_API_KEY` = (from config.json)
   - `ADMIN_TOKEN` = (from config.json, supabase_admin_token)
   - `SUPABASE_URL` = https://umjerckgospmifikdrli.supabase.co

## Option 2: Supabase CLI

```bash
supabase login
supabase link --project-ref umjerckgospmifikdrli
supabase secrets set GEMINI_API_KEY=... ADMIN_TOKEN=... SUPABASE_URL=...
supabase functions deploy driver-weighting-stufe-a
```

## Testing

```bash
# Test single asset
curl -X POST "https://umjerckgospmifikdrli.supabase.co/functions/v1/driver-weighting-stufe-a" \
  -H "Authorization: Bearer <anon_key>" \
  -H "Content-Type: application/json" \
  -d '{"tickers": ["GC"]}'

# Test all assets
curl -X POST "https://umjerckgospmifikdrli.supabase.co/functions/v1/driver-weighting-stufe-a" \
  -H "Authorization: Bearer <anon_key>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## pg_cron Schedule (after PoC verification)

```sql
-- Weekly Monday 08:00 CEST (06:00 UTC)
SELECT cron.schedule(
  'stufe-a-edge-weighting',
  '0 6 * * 1',
  $$
  SELECT net.http_post(
    url := 'https://umjerckgospmifikdrli.supabase.co/functions/v1/driver-weighting-stufe-a',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```
