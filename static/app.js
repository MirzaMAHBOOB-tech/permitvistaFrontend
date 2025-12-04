// /static/app.js
(() => {
  const API_BASE = 'http://127.0.0.1:8000';

  function setStatus(msg, isError = false) {
    let s = document.getElementById("statusLine");
    if (!s) {
      s = document.createElement("div");
      s.id = "statusLine";
      s.style.cssText = `
        width:100%;
        max-width:980px;
        margin:10px auto;
        padding:8px 12px;
        font-size:13px;
        color:#111;
        text-align:center;
        border-radius:4px;
      `;
      document.body.insertBefore(s, document.body.children[2] || null);
    }
    s.textContent = msg || "";
    s.style.background = isError ? "#fff0f0" : "#f0fff4";
    s.style.color = isError ? "#900" : "#044";
    console.info("[status]", msg);
  }

  // Generic fetch JSON with Abort timeout
  async function fetchJson(url, opts = {}, timeout = 12000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(id);
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      return await resp.json();
    } catch (err) {
      clearTimeout(id);
      const em = (err && err.message) ? err.message : "";
      const isAbort = err && (err.name === "AbortError" || /aborted|AbortError|signal is aborted/i.test(em));
      if (isAbort) throw new Error("Request timeout — server took too long to respond");
      throw err;
    }
  }

  // fetch that can also return pdf blob or raw text; improved Abort handling
  async function fetchJsonOrBinary(url, opts = {}, timeout = 180000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(id);
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json")) return { ok: resp.ok, status: resp.status, json: await resp.json(), resp };
      if (ct.includes("application/pdf")) {
        const blob = await resp.blob();
        return { ok: resp.ok, status: resp.status, pdf_blob: blob, resp };
      }
      const text = await resp.text().catch(()=>"");
      return { ok: resp.ok, status: resp.status, raw: text, resp };
    } catch (err) {
      clearTimeout(id);
      const em = (err && err.message) ? err.message : "";
      const isAbort = err && (err.name === "AbortError" || /aborted|AbortError|signal is aborted/i.test(em));
      if (isAbort) throw new Error("Request timeout — server took too long to respond");
      throw err;
    }
  }

  // ---------- Google Places / Autocomplete helpers ----------
  function parsePlaceToSubfields(place) {
    const comps = { street_number: "", route: "", postal_code: "", locality: "", administrative_area_level_1: "", country: "" };
    if (!place || !place.address_components) return comps;
    place.address_components.forEach(ac => {
      if (!ac.types || !ac.types.length) return;
      if (ac.types.includes("street_number")) comps.street_number = ac.long_name || ac.short_name || "";
      if (ac.types.includes("route")) comps.route = ac.long_name || ac.short_name || "";
      if (ac.types.includes("postal_code")) comps.postal_code = ac.long_name || ac.short_name || "";
      if (ac.types.includes("locality") || ac.types.includes("postal_town")) comps.locality = ac.long_name || ac.short_name || "";
      if (ac.types.includes("administrative_area_level_1")) comps.administrative_area_level_1 = ac.short_name || ac.long_name || "";
      if (ac.types.includes("country")) comps.country = ac.short_name || ac.long_name || "";
    });

    let streetName = comps.route || "";
    let streetType = "";
    let streetDir = "";
    if (streetName) {
      const types = ["Street","St","Avenue","Ave","Boulevard","Blvd","Road","Rd","Lane","Ln","Drive","Dr","Court","Ct","Terrace","Ter","Place","Pl","Way","Wy","Circle","Cir","Trail","Trl","Parkway","Pkwy","Square","Sq","Alley","Aly"];
      const tokens = streetName.trim().split(/\s+/);
      // detect direction token at start or end
      const dirTokens = ["N","S","E","W","NE","NW","SE","SW","North","South","East","West"];
      if (tokens.length > 1) {
        const first = tokens[0].replace(/\./g, "");
        const last = tokens[tokens.length - 1].replace(/\./g, "");
        if (dirTokens.includes(first)) { streetDir = first; tokens.shift(); }
        else if (dirTokens.includes(last)) { streetDir = last; tokens.pop(); }
      }
      let matchedType = null;
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i].replace(/\./g, "");
        if (types.find(tt => tt.toLowerCase() === t.toLowerCase())) { matchedType = tokens[i]; tokens.splice(i,1); break; }
      }
      if (matchedType) {
        streetType = matchedType;
        streetName = tokens.join(" ");
      }
    }

    return {
      street_number: comps.street_number || "",
      street_name: streetName || "",
      street_type: streetType || "",
      street_dir: streetDir || "",
      postal_code: comps.postal_code || "",
      city: comps.locality || "",
      state: comps.administrative_area_level_1 || "",
      country: comps.country || ""
    };
  }

  function initAutocompleteSafe() {
    if (!(window.google && window.google.maps && window.google.maps.places)) {
      console.warn("Google Maps Places not available — autocomplete disabled");
      return;
    }
    const addrInput = document.getElementById("addressInput");
    if (!addrInput) { console.warn("addressInput not found"); return; }
    const options = { types: ["address"] };
    const autocomplete = new window.google.maps.places.Autocomplete(addrInput, options);
    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place || !place.address_components) {
        setStatus("Address picked (partial). We will try best-effort parsing.");
      } else {
        setStatus("Address selected.");
      }
      const parsed = parsePlaceToSubfields(place);
      if (place && place.formatted_address) addrInput.value = place.formatted_address;
      document.getElementById("addr_number").value = parsed.street_number || "";
      document.getElementById("addr_name").value = parsed.street_name || "";
      document.getElementById("addr_type").value = parsed.street_type || "";
      document.getElementById("addr_zip").value = parsed.postal_code || "";
      addrInput.dataset.parsed = JSON.stringify(parsed);
      console.log("Parsed address:", parsed);
    });
  }
  window.initAutocomplete = initAutocompleteSafe;

  // ---------- Existing search / permit flow ----------
  function chooseIdFromRecord(rec) {
    const keys = ["PermitNumber", "PermitNum", "_id", "ID", "OBJECTID", "FID", "ApplicationNumber"];
    if (!rec) return "unknown";
    for (const k of keys) if (rec[k]) return String(rec[k]);
    for (const k of Object.keys(rec)) if (rec[k]) return String(rec[k]);
    return "unknown";
  }
  function safeText(v) { return (v===null||v===undefined)?"":String(v); }
  function makeAbsoluteUrl(maybeUrl) {
    if (!maybeUrl) return "";
    try { return new URL(maybeUrl, API_BASE).href; } catch (e) { return API_BASE + (maybeUrl.startsWith("/") ? maybeUrl : `/${maybeUrl}`); }
  }

  async function fetchAndRenderSearch(url) {
    const resultsDiv = document.getElementById("results");
    const searchButton = document.getElementById("searchButton");
    setStatus("Searching (this may take a bit)...");
    if (resultsDiv) { resultsDiv.style.display = "block"; resultsDiv.innerHTML = "<p>Searching...</p>"; }
    if (searchButton) searchButton.disabled = true;
    const t0 = performance.now();
    try {
      const r = await fetchJsonOrBinary(url, {}, 180000); // 180s
      if (!r.ok) { setStatus(`Server returned ${r.status}`, true); if (resultsDiv) resultsDiv.innerHTML = `<p style="color:#dc2626">Server returned ${r.status}</p>`; return; }
      const results = (r.json && r.json.results) ? r.json.results : [];
      const dbg = {
        server_duration_ms: r.json && typeof r.json.duration_ms === "number" ? r.json.duration_ms : undefined,
        canonical_hit: r.json && typeof r.json.canonical_hit !== "undefined" ? r.json.canonical_hit : undefined
      };
      console.debug("[search] response meta:", dbg);
      renderResults(results);
      setStatus(`${results.length} result(s) found`);
      // Auto-open PDF when exactly one canonical match returned
      try {
        if (results.length === 1 && dbg.canonical_hit) {
          const only = results[0];
          const id = chooseIdFromRecord(only);
          const encodedId = encodeURIComponent(id);
          const viewLink = makeAbsoluteUrl(only.view_url || `/view/${encodedId}`);
          setStatus("Exact match found — opening PDF...");
          openPdfUrl(viewLink);
        }
      } catch (e) { /* ignore */ }
    } catch (err) {
      const em = (err && err.message) ? err.message : String(err);
      if (em.includes("Request timeout")) {
        setStatus("Search timed out — server took too long to respond.", true);
        if (resultsDiv) resultsDiv.innerHTML = `<p style="color:#dc2626">Search timed out. Try again or increase server scan limit.</p>`;
      } else {
        setStatus(`Network error: ${em}`, true);
        if (resultsDiv) resultsDiv.innerHTML = `<p style="color:#dc2626">Network error: ${em}</p>`;
      }
    } finally {
      console.debug("[search] total elapsed ms:", Math.round(performance.now() - t0));
      if (searchButton) searchButton.disabled = false;
    }
  }

  function renderResults(list) {
    const resultsDiv = document.getElementById("results");
    if (!resultsDiv) return;
    if (!list?.length) { resultsDiv.style.display = "block"; resultsDiv.innerHTML = "<p>No results found.</p>"; return; }
    resultsDiv.style.display = "block";
    resultsDiv.innerHTML = list.map(item => {
      const id = chooseIdFromRecord(item);
      const permitNum = item.PermitNumber || item.PermitNum || id;
      const addr = item.Address || item.PropertyAddress || item.StreetAddress || item.AddressDescription || "Unknown address";
      const city = item.City || item.PropertyCity || "";
      const status = item.StatusCurrentMapped || item.CurrentStatus || item.PermitStatus || "";
      const encodedId = encodeURIComponent(id);
      const viewLink = makeAbsoluteUrl(item.view_url || `/view/${encodedId}`);
      const downloadLink = makeAbsoluteUrl(item.download_url || `/download/${encodedId}.pdf`);
      return `
        <div class="permit-card" style="background:#fff;padding:12px;border-radius:8px;border:1px solid #e5e7eb;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">
          <div style="flex:1;min-width:0;">
            <h4 style="margin:0 0 6px 0;font-size:16px;color:#111827;">${safeText(permitNum)}</h4>
            <div style="color:#6b7280;font-size:13px;margin-bottom:8px;">${safeText(addr)}${city ? ' • ' + safeText(city) : ''}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${status ? `<div style="background:#f3f4f6;padding:6px 8px;border-radius:6px;font-weight:600;">${safeText(status)}</div>` : ""}
              ${item.AppliedDate ? `<div style="background:#f3f4f6;padding:6px 8px;border-radius:6px;font-weight:600;">Applied: ${safeText(item.AppliedDate)}</div>` : ""}
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-left:12px;">
            <a href="${viewLink}" target="_blank" rel="noopener" style="padding:8px 12px;border-radius:8px;background:#2563eb;color:#fff;text-decoration:none;">View PDF</a>
            <a href="${downloadLink}" target="_blank" rel="noopener" style="padding:8px 12px;border-radius:8px;background:#10b981;color:#fff;text-decoration:none;">Download</a>
          </div>
        </div>` ;
    }).join("");
  }

  function openPdfUrl(url) {
    try {
      const win = window.open(url, "_blank");
      if (!win) {
        alert("Popup blocked. Please allow popups to view the PDF.");
      }
    } catch (e) {
      alert("Cannot open PDF: " + e.message);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    setStatus("Ready.");
    const searchForm = document.getElementById("searchForm");
    const searchButton = document.getElementById("searchButton") || document.getElementById("searchButton_small");
    const cityInput = document.getElementById("cityInput");
    const permitInput = document.getElementById("permitInput");
    const addressInput = document.getElementById("addressInput");
    const addressNumber = document.getElementById("addr_number");
    const addressName = document.getElementById("addr_name");
    const addressType = document.getElementById("addr_type");
    const addressZip = document.getElementById("addr_zip");
    const dateFrom = document.getElementById("dateFrom");
    const dateTo = document.getElementById("dateTo");

    if (window.google && window.google.maps && window.google.maps.places) {
      try { initAutocompleteSafe(); } catch(e) { console.warn("initAutocomplete failed:", e); }
    } else {
      console.info("Google Places not loaded yet; waiting for callback initAutocomplete");
    }

    // Removed permit-only auto lookup; address is required for search

    if (searchForm) {
      searchForm.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const city = cityInput ? cityInput.value.trim() : "";
        const permit = permitInput ? permitInput.value.trim() : "";
        const address = addressInput ? addressInput.value.trim() : "";
        const df = dateFrom ? dateFrom.value : "";
        const dt = dateTo ? dateTo.value : "";

        // Address is mandatory
        if (!address) { setStatus("Property Address is required.", true); return; }

        // Build search URL and use long timeout (180s). Permit is optional, used only with address.
        const params = new URLSearchParams();
        params.append("address", address);
        if (city) params.append("city", city);
        if (permit) params.append("permit", permit);
        if (df) params.append("date_from", df);
        if (dt) params.append("date_to", dt);
        params.append("max_results", "500");
        // increase scan limit to search more CSV blobs on the server
        params.append("scan_limit", "200");
        // include structured address parts from Google selection if available
        try {
          const parsed = addressInput && addressInput.dataset && addressInput.dataset.parsed ? JSON.parse(addressInput.dataset.parsed) : null;
          console.debug("[search] params (pre-url):", {
            address, city, df, dt, parsed
          });
          if (parsed) {
            if (parsed.street_number) params.append("street_number_q", parsed.street_number);
            if (parsed.street_name) params.append("street_name_q", parsed.street_name);
            if (parsed.street_type) params.append("street_type_q", parsed.street_type);
            if (parsed.street_dir) params.append("street_dir_q", parsed.street_dir);
            if (parsed.postal_code) params.append("zip_q", parsed.postal_code);
          }
        } catch (e) { /* ignore */ }

        const url = `${API_BASE}/search?${params.toString()}`;
        console.debug("[search] url:", url);
        // Open loading page
        let loadingWin = null;
        try { loadingWin = window.open(makeAbsoluteUrl("/static/loading.htm"), "_blank"); } catch(e) {}
        // Fire the search; backend will early-return with PDF if a match is found
        try {
          const r = await fetchJsonOrBinary(url, {}, 180000);
          if (!r.ok) { setStatus(`Server returned ${r.status}`, true); return; }
          const j = r.json || {};
          if (j.pdf_error) {
            console.error("[pdf] generation error:", j.pdf_error);
            setStatus("Match found but PDF generation failed.", true);
            alert("PDF generation failed. See console for details.");
            try { if (loadingWin) loadingWin.close(); } catch(e) {}
            return;
          }
          const targetView = j.view_url || (j.results && j.results[0] && (j.results[0].view_url)) || null;
          if (targetView) {
            setStatus("Match found — opening PDF...");
            const href = makeAbsoluteUrl(targetView);
            try {
              if (loadingWin) {
                loadingWin.location = href;
                loadingWin.focus();
              } else {
                openPdfUrl(href);
              }
            } catch (e) {
              openPdfUrl(href);
            }
          } else {
            setStatus("No matching record found.", true);
            try { if (loadingWin) loadingWin.close(); } catch(e) {}
          }
        } catch (err) {
          const em = (err && err.message) ? err.message : String(err);
          if (em.includes("Request timeout")) setStatus("Search timed out — server took too long to respond.", true);
          else setStatus(`Network error: ${em}`, true);
          try { if (loadingWin) loadingWin.close(); } catch(e) {}
        }
      });
    }
  });
})();
