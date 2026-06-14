// Type shim for the existing JS Supabase client. Just enough so that
// tsc strict mode doesn't reject the .js import.
import type { SupabaseClient } from "@supabase/supabase-js";
export const supabase: SupabaseClient;
