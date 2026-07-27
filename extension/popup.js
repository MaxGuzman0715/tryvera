// Popup: sign-in + profile picker (Slice 1). On load it decides which view to
// show based on stored auth, validates the token with /api/auth/me, then lets
// the user pick which enpply profile future generations should use.

import { login, me, listProfiles, ApiError } from "./lib/api.js";
import {
  getApiBase,
  setApiBase,
  getAuth,
  setAuth,
  clearAuth,
  getSelectedProfile,
  setSelectedProfile,
  getAutoDownloadPrefs,
  setAutoDownloadPrefs,
  DEFAULT_API_BASE,
} from "./lib/storage.js";

const $ = (id) => document.getElementById(id);
const authView = $("authView");
const appView = $("appView");
const statusEl = $("status");

function setStatus(msg, kind = "") {
  statusEl.textContent = msg || "";
  statusEl.className = `status${kind ? " " + kind : ""}`;
}

function show(view) {
  authView.classList.toggle("hidden", view !== "auth");
  appView.classList.toggle("hidden", view !== "app");
  $("signOut").classList.toggle("hidden", view !== "app");
}

async function renderSignedIn(user) {
  $("userEmail").textContent = user.email;
  show("app");
  setStatus("Loading profiles…");
  try {
    const profiles = await listProfiles();
    const select = $("profile");
    select.innerHTML = "";
    if (!profiles.length) {
      $("profileHint").textContent = "No profiles available for this account.";
      setStatus("");
      return;
    }
    const chosen = await getSelectedProfile();
    for (const p of profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.basic?.fullName ? `${p.basic.fullName} (${p.id})` : p.id;
      if (p.id === chosen) opt.selected = true;
      select.appendChild(opt);
    }
    // Default the selection if nothing valid was stored.
    if (!profiles.some((p) => p.id === chosen)) {
      await setSelectedProfile(select.value);
    }
    $("profileHint").textContent = "Used as the résumé profile when generating from a job page.";
    // Load the auto-download folder preference into its controls.
    const auto = await getAutoDownloadPrefs();
    $("autoEnabled").checked = auto.enabled;
    $("autoDir").value = auto.dir;
    setStatus("");
  } catch (e) {
    setStatus(e.message || String(e), "error");
  }
}

async function saveAutoPrefs() {
  await setAutoDownloadPrefs({
    enabled: $("autoEnabled").checked,
    dir: $("autoDir").value,
  });
}

async function init() {
  // Prefill API base.
  $("apiBase").value = await getApiBase();
  if (!$("apiBase").value) $("apiBase").value = DEFAULT_API_BASE;

  const { token, user } = await getAuth();
  if (!token) {
    show("auth");
    return;
  }
  // Validate the stored token before trusting it.
  try {
    const res = await me();
    await renderSignedIn(res.user || user);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await clearAuth();
      show("auth");
      setStatus("Session expired — please sign in.", "error");
    } else {
      // Network/base issue: still allow editing the API base and retrying.
      show("auth");
      setStatus(e.message || String(e), "error");
    }
  }
}

$("signIn").addEventListener("click", async () => {
  const apiBase = $("apiBase").value.trim();
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!apiBase) return setStatus("Enter the API base URL.", "error");
  if (!email || !password) return setStatus("Enter email and password.", "error");

  await setApiBase(apiBase);
  setStatus("Signing in…");
  $("signIn").disabled = true;
  try {
    const res = await login(email, password);
    if (!res.token) throw new Error("Server did not return a token.");
    await setAuth(res.token, res.user);
    $("password").value = "";
    await renderSignedIn(res.user);
  } catch (e) {
    setStatus(e.message || String(e), "error");
  } finally {
    $("signIn").disabled = false;
  }
});

$("signOut").addEventListener("click", async () => {
  await clearAuth();
  show("auth");
  setStatus("Signed out.");
});

$("profile").addEventListener("change", async (e) => {
  await setSelectedProfile(e.target.value);
  setStatus("Profile selected.", "ok");
});

$("autoEnabled").addEventListener("change", async () => {
  await saveAutoPrefs();
  setStatus("Download-folder preference saved.", "ok");
});
$("autoDir").addEventListener("change", async () => {
  await saveAutoPrefs();
  setStatus("Download-folder preference saved.", "ok");
});

init();
