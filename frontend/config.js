/* =====================================================================
   LokaChat - frontend configuration

   SUPABASE_URL       Supabase Dashboard -> Project Settings -> API -> Project URL
   SUPABASE_ANON_KEY  Same page -> Project API keys -> "anon" / "public" key
                      (safe to expose in the browser; never paste the service_role key here)
   API_URL            "/api" - the FastAPI backend is deployed in the SAME Vercel project,
                      so it is reached on the same domain (no CORS). Only change this if you
                      host the API elsewhere (then use the full URL, no trailing slash).
   ===================================================================== */
window.LOKA_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  API_URL: "/api",
};
