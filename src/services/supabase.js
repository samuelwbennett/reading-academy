// Supabase browser client. Same project as the rest of VPA.
// Anon key is safe to ship — RLS policies decide what a signed-in
// user can see. Service-role secret stays server-side.

import { createClient } from "@supabase/supabase-js";

const env = import.meta.env || {};

const SUPABASE_URL =
  env.VITE_SUPABASE_URL || "https://dtkrnyberbpfdmikpdnw.supabase.co";

const SUPABASE_ANON_KEY =
  env.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0a3JueWJlcmJwZmRtaWtwZG53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MDE0MzIsImV4cCI6MjA5MzM3NzQzMn0.oElhVtcEbq8nDBBFzpsTdfDcSGO1b6TLBclKFxBAUC8";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
