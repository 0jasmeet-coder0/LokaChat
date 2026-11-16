/* =====================================================================
   LokaChat - frontend configuration

   SUPABASE_URL       Supabase Dashboard -> Project Settings -> API -> Project URL
   SUPABASE_ANON_KEY  Same page -> Project API keys -> "anon" / "public" key
                      (safe to expose in the browser; never paste the service_role key here)
   API_URL            "/api" - the FastAPI backend is deployed in the SAME Vercel project,
                      so it is reached on the same domain (no CORS). Only change this if you
                      host the API elsewhere (then use the full URL, no trailing slash).
   MOBILE_API_URL     ONLY for the Capacitor mobile app (inside it "/api" cannot work). Set it to your
                      live Vercel URL + /api, e.g. "https://your-app.vercel.app/api". Ignored on the web.
   ===================================================================== */
window.LOKA_CONFIG = {
  SUPABASE_URL: "https://cfzucdlkalhmirorhvyi.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmenVjZGxrYWxobWlyb3JodnlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NzEwMDYsImV4cCI6MjExMDI0NzAwNn0.8z2jZWkhVT4oJBbHVmnjw3tG8vwwfpUFD-ih_qLFEq4",
  API_URL: "/api",
  MOBILE_API_URL: "https://loka-chat.vercel.app/api", // <- paste "https://YOUR-APP.vercel.app/api" before building the Android/iOS app
};
