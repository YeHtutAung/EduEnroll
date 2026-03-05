#!/bin/bash
echo "Running Supabase migrations..."
npx supabase db push
echo "Migration complete."
