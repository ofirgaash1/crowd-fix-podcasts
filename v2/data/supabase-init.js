// v2/data/supabase-init.js
// Lazy-load Supabase client and pass it to API layer's configureSupabase.

import { configureSupabase } from './api.js';

export function setupSupabase() {
  const SUPABASE_URL = 'https://xblbzxyyoptnfrlffigv.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhibGJ6eHl5b3B0bmZybGZmaWd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3ODI1MjgsImV4cCI6MjA3MTM1ODUyOH0.eIB279AoKwL5mrXuX1BQxa1mevVXMPrZK2VLaZ5kTNE';
  return import('https://esm.sh/@supabase/supabase-js@2')
    .then(({ createClient }) => {
      try {
        const client = createClient(SUPABASE_URL, SUPABASE_KEY);
        configureSupabase(client);
        console.log('Supabase configured');
      } catch (e) {
        console.warn('Supabase init error:', e);
      }
    })
    .catch((e) => {
      console.warn('Supabase SDK load failed:', e);
    });
}

