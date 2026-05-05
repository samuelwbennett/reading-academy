// Auth wrappers — same shape as the dashboard's so behavior matches.

import { supabase } from "./supabase.js";

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthChange(cb) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    (_event, session) => cb(session)
  );
  return () => subscription.unsubscribe();
}

export async function signInWithPassword(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signInWithMagicLink(email) {
  return supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
}

export async function signOut() {
  return supabase.auth.signOut();
}

// Resolve the student row tied to the signed-in auth user. null if
// no link exists yet.
export async function fetchLinkedStudent() {
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) return null;

  const { data: student, error } = await supabase
    .from("students")
    .select("id, display_name, grade_level, auth_user_id")
    .eq("auth_user_id", userData.user.id)
    .maybeSingle();

  if (error) {
    console.warn("[auth] fetchLinkedStudent failed:", error.message);
    return null;
  }
  return student || null;
}
