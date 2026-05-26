const TMDB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIxNWE3NTQ3YTA3YmJhYWI4MDNiZjg2OTY5NWNmYWU4YSIsIm5iZiI6MTc3OTc1NTU2OS41MTAwMDAyLCJzdWIiOiI2YTE0ZWEzMTU3NjQyOTRhYWY1NDVmYjYiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.26UDXfdrFPiAEUf4AS4_gDmyc-RcElN3NR6fDABPJqI";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w92";

const searchInput = document.getElementById("show-search");
const autocompleteResults = document.getElementById("autocomplete-results");
const blocklistEl = document.getElementById("blocklist");
const emptyState = document.getElementById("empty-state");

let debounceTimer;
let blocklist = [];

// Load blocklist from storage
chrome.storage.local.get("blocklist", (data) => {
  blocklist = data.blocklist || [];
  renderBlocklist();
});

// Search input handler
searchInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const query = searchInput.value.trim();

  if (query.length < 2) {
    autocompleteResults.style.display = "none";
    return;
  }

  debounceTimer = setTimeout(() => searchTMDB(query), 300);
});

// Close autocomplete when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-section")) {
    autocompleteResults.style.display = "none";
  }
});

async function searchTMDB(query) {
  try {
    const res = await fetch(
      `${TMDB_BASE}/search/multi?query=${encodeURIComponent(query)}&include_adult=false&language=en-US&page=1`,
      {
        headers: {
          Authorization: `Bearer ${TMDB_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    const data = await res.json();
    const results = data.results
      .filter((r) => r.media_type === "tv" || r.media_type === "movie")
      .slice(0, 5);
    renderAutocomplete(results);
  } catch (err) {
    console.error("TMDB search error:", err);
  }
}

function renderAutocomplete(results) {
  autocompleteResults.innerHTML = "";

  if (results.length === 0) {
    autocompleteResults.style.display = "none";
    return;
  }

  results.forEach((item) => {
    const title = item.title || item.name;
    const year = (item.release_date || item.first_air_date || "").slice(0, 4);
    const type = item.media_type === "tv" ? "TV Series" : "Movie";
    const poster = item.poster_path ? `${TMDB_IMG}${item.poster_path}` : null;

    const div = document.createElement("div");
    div.className = "autocomplete-item";
    div.innerHTML = `
      ${poster ? `<img src="${poster}" alt="${title}" />` : `<div style="width:32px;height:48px;background:#2a2a2a;border-radius:4px;"></div>`}
      <div class="show-info">
        <div class="show-title">${title}</div>
        <div class="show-meta">${type}${year ? " · " + year : ""}</div>
      </div>
    `;

    div.addEventListener("click", () => addToBlocklist(item));
    autocompleteResults.appendChild(div);
  });

  autocompleteResults.style.display = "block";
}

function addToBlocklist(item) {
  const title = item.title || item.name;
  const year = (item.release_date || item.first_air_date || "").slice(0, 4);
  const id = item.id;

  const alreadyAdded = blocklist.find((b) => b.id === id);
  if (alreadyAdded) {
    autocompleteResults.style.display = "none";
    searchInput.value = "";
    return;
  }

  const entry = {
    id,
    title,
    year,
    type: item.media_type,
  };

  blocklist.push(entry);
  chrome.storage.local.set({ blocklist });
  renderBlocklist();

  searchInput.value = "";
  autocompleteResults.style.display = "none";
}

function removeFromBlocklist(id) {
  blocklist = blocklist.filter((b) => b.id !== id);
  chrome.storage.local.set({ blocklist });
  renderBlocklist();
}

function renderBlocklist() {
  blocklistEl.innerHTML = "";

  if (blocklist.length === 0) {
    emptyState.style.display = "block";
    return;
  }

  emptyState.style.display = "none";

  blocklist.forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span>
        <span class="show-name">${item.title}</span>
        ${item.year ? `<span class="show-year">${item.year}</span>` : ""}
      </span>
      <button data-id="${item.id}" title="Remove">×</button>
    `;
    li.querySelector("button").addEventListener("click", () =>
      removeFromBlocklist(item.id)
    );
    blocklistEl.appendChild(li);
  });
}