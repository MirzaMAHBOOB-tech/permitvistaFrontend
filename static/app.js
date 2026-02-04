// /static/app.js
// Define initAutocomplete callback globally BEFORE Google Maps script loads
// This MUST be a global function that Google Maps can call
window.initAutocomplete = function() {
  console.log("Google Maps API loaded, callback called");
  // The actual initialization will happen in DOMContentLoaded
  // If DOM is already loaded, try to initialize immediately
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(function() {
      if (window.google && window.google.maps && window.google.maps.places) {
        try {
          if (typeof window._initAutocompleteInternal === 'function') {
            window._initAutocompleteInternal();
          }
        } catch (e) {
          console.warn("Early autocomplete init failed:", e);
        }
      }
    }, 100);
  }
};

(() => {
  // Auto-detect API base URL based on current hostname
  const isProduction = window.location.hostname.includes('render.com') || window.location.hostname.includes('permitvistafrontend');
  const API_BASE = isProduction 
    ? 'https://permitvistabackend.onrender.com' 
    : 'http://127.0.0.1:8000';
  const API_BASE_URL = API_BASE; // Alias for consistency

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
    if (!addrInput) { 
      console.warn("addressInput not found"); 
      return; 
    }
    const options = { types: ["address"] };
    const autocomplete = new window.google.maps.places.Autocomplete(addrInput, options);
    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place || !place.address_components) {
        setStatus("Address picked (partial). We will try best-effort parsing.");
      } else {
        setStatus("Address selected. You can edit the sub-fields below if needed.");
      }
      const parsed = parsePlaceToSubfields(place);
      if (place && place.formatted_address) addrInput.value = place.formatted_address;
      // Auto-fill sub-fields, but allow user to edit them
      const addrNumberEl = document.getElementById("addr_number");
      const addrNameEl = document.getElementById("addr_name");
      const addrTypeEl = document.getElementById("addr_type");
      const addrZipEl = document.getElementById("addr_zip");
      
      if (addrNumberEl && !addrNumberEl.value.trim()) {
        addrNumberEl.value = parsed.street_number || "";
      }
      if (addrNameEl && !addrNameEl.value.trim()) {
        addrNameEl.value = parsed.street_name || "";
      }
      if (addrTypeEl && !addrTypeEl.value.trim()) {
        addrTypeEl.value = parsed.street_type || "";
      }
      if (addrZipEl && !addrZipEl.value.trim()) {
        addrZipEl.value = parsed.postal_code || "";
      }
      
      // Store parsed data for reference, but user can override by editing fields
      addrInput.dataset.parsed = JSON.stringify(parsed);
      console.log("Parsed address:", parsed);
    });
  }

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

  // Simple function to empty all form fields - make it globally accessible
  window.emptyAllFields = function emptyAllFields() {
    console.log("[emptyAllFields] ===== STARTING TO EMPTY ALL FIELDS =====");
    
    // Get all form elements first
    const addressInput = document.getElementById("addressInput");
    const cityInput = document.getElementById("cityInput");
    const unitInput = document.getElementById("unitInput");
    const permitInput = document.getElementById("permitInput");
    const dateFrom = document.getElementById("dateFrom");
    const dateTo = document.getElementById("dateTo");
    const addrNumber = document.getElementById("addr_number");
    const addrName = document.getElementById("addr_name");
    const addrType = document.getElementById("addr_type");
    const addrZip = document.getElementById("addr_zip");
    const searchForm = document.getElementById("searchForm");
    
    // Blur addressInput first to prevent Google autocomplete from triggering
    if (addressInput) {
      addressInput.blur();
    }
    
    // Set all values to empty string IMMEDIATELY
    if (addressInput) {
      addressInput.value = "";
      if (addressInput.dataset) {
        delete addressInput.dataset.parsed;
      }
      console.log("[emptyAllFields] Address cleared, value:", addressInput.value);
    }
    
    if (cityInput) {
      cityInput.value = "";
      console.log("[emptyAllFields] City cleared, value:", cityInput.value);
    }
    if (unitInput) {
      unitInput.value = "";
      console.log("[emptyAllFields] Unit cleared, value:", unitInput.value);
    }
    if (permitInput) {
      permitInput.value = "";
      console.log("[emptyAllFields] Permit cleared, value:", permitInput.value);
    }
    if (dateFrom) {
      dateFrom.value = "";
      console.log("[emptyAllFields] DateFrom cleared, value:", dateFrom.value);
    }
    if (dateTo) {
      dateTo.value = "";
      console.log("[emptyAllFields] DateTo cleared, value:", dateTo.value);
    }
    if (addrNumber) {
      addrNumber.value = "";
      console.log("[emptyAllFields] AddrNumber cleared, value:", addrNumber.value);
    }
    if (addrName) {
      addrName.value = "";
      console.log("[emptyAllFields] AddrName cleared, value:", addrName.value);
    }
    if (addrType) {
      addrType.value = "";
      console.log("[emptyAllFields] AddrType cleared, value:", addrType.value);
    }
    if (addrZip) {
      addrZip.value = "";
      console.log("[emptyAllFields] AddrZip cleared, value:", addrZip.value);
    }
    
    // Also try form.reset() as backup
    if (searchForm) {
      try {
        searchForm.reset();
        console.log("[emptyAllFields] Form.reset() called");
      } catch (e) {
        console.warn("[emptyAllFields] Form.reset() failed:", e);
      }
    }
    
    // Force a small delay to prevent Google autocomplete from repopulating
    setTimeout(() => {
      // Double-check all fields are still empty
      if (addressInput && addressInput.value) {
        console.warn("[emptyAllFields] Address was repopulated! Clearing again...");
        addressInput.value = "";
        if (addressInput.dataset) delete addressInput.dataset.parsed;
    }
      if (cityInput && cityInput.value) {
        console.warn("[emptyAllFields] City was repopulated! Clearing again...");
        cityInput.value = "";
      }
      if (permitInput && permitInput.value) {
        console.warn("[emptyAllFields] Permit was repopulated! Clearing again...");
        permitInput.value = "";
      }
      console.log("[emptyAllFields] ===== ALL FIELDS EMPTIED SUCCESSFULLY =====");
    }, 100);
  }

  // Function to clear all form fields (keeping for backward compatibility)
  function clearFormFields() {
    emptyAllFields();
  }

  // Store matched records
  let matchedRecords = []; // legacy: now treated as "all records"
  let allRecords = [];
  let unitFilteredRecords = [];
  let displayedRecords = [];
  let activeUnitNumber = "";
  let showAllBuildingPermits = false;
  let searchInProgress = false;

  function normalizeUnitNumber(raw) {
    return String(raw || "").trim();
  }

  function matchesUnit(description, unitNumber) {
    const desc = String(description || "");
    const unit = String(unitNumber || "").trim();
    if (!desc || !unit) return false;
    const safeUnit = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // escape regex

    const patterns = [
      `unit\\s*no\\.?\\s*:??\\s*${safeUnit}\\b`,   // Unit no.: 426, Unit no 426
      `unit\\s*#?\\s*:??\\s*${safeUnit}\\b`,       // Unit 426, Unit:426, Unit #426
      `#\\s*${safeUnit}\\b`,                       // #426
      `apt\\.?\\s*${safeUnit}\\b`,                 // apt 426, apt. 426
      `apartment\\s*${safeUnit}\\b`,               // apartment 426
    ];

    const regex = new RegExp(patterns.join("|"), "i");
    return regex.test(desc);
  }

  function getRecordDescription(rec) {
    return (
      rec.work_description ||
      rec.WorkDescription ||
      rec.ProjectDescription ||
      rec.ProjectName ||
      rec.Description ||
      rec["Desc1-Desc10"] ||
      rec.WorkType ||
      ""
    );
  }

  function applyUnitFilter() {
    const unitInput = document.getElementById("unitInput");
    activeUnitNumber = normalizeUnitNumber(unitInput ? unitInput.value : "");

    unitFilteredRecords = [];
    if (activeUnitNumber) {
      unitFilteredRecords = allRecords.filter((r) => matchesUnit(getRecordDescription(r), activeUnitNumber));
    }

    // Decide which list to display
    if (!activeUnitNumber) {
      displayedRecords = allRecords.slice();
      showAllBuildingPermits = false;
    } else if (showAllBuildingPermits) {
      displayedRecords = allRecords.slice();
    } else if (unitFilteredRecords.length > 0) {
      displayedRecords = unitFilteredRecords.slice();
    } else {
      // Edge case: no matches -> show all, but show message in UI
      displayedRecords = allRecords.slice();
    }
  }

  async function fetchAndRenderSearch(url) {
    console.log("[fetchAndRenderSearch] Starting search with URL:", url);
    const resultsDiv = document.getElementById("results");
    const searchButton = document.getElementById("searchButton");
    
    if (!resultsDiv) {
      console.error("[fetchAndRenderSearch] Results div not found!");
      setStatus("Error: Results container not found", true);
      return;
    }
    
    // Reset previous results
    matchedRecords = [];
    allRecords = [];
    unitFilteredRecords = [];
    displayedRecords = [];
    showAllBuildingPermits = false;
    searchInProgress = true;
    
    setStatus("Searching...");
    console.log("[fetchAndRenderSearch] Showing results container");
    
    // Show and initialize results container with "Searching..." message
    const resultsContent = document.getElementById("resultsContent");
    if (resultsContent) {
      resultsContent.innerHTML = `
        <div id="resultsContainer" style="width: 100%;">
          <div id="resultsHeader" style="text-align: center; margin-bottom: 15px;">
            <h3 id="resultsStatus" style="margin: 0; color: #20334e; font-size: 18px; font-weight: 700;">Searching...</h3>
            <div id="recordCount" style="display:none;"></div>
          </div>
          <div id="resultsCards" style="display: flex; flex-direction: column; gap: 12px; width: 100%;"></div>
        </div>
      `;
    }
    resultsDiv.style.display = "block";
    resultsDiv.style.visibility = "visible"; 
    
    if (searchButton) searchButton.disabled = true;
    
    const t0 = performance.now();
    
    // Fallback function for regular search
    async function fallbackToRegularSearch(searchUrl) {
      try {
        const response = await fetch(searchUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          }
        });
        
        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.error) {
          setStatus(`Error: ${data.error}`, true);
          const statusElement = document.getElementById("resultsStatus");
          if (statusElement) {
            statusElement.textContent = `Error: ${data.error}`;
          }
          if (searchButton) searchButton.disabled = false;
          searchInProgress = false;
          return;
        }
        
        const results = data.results || [];
        
        if (results.length === 0) {
          setStatus("No records found.", true);
          const statusElement = document.getElementById("resultsStatus");
          if (statusElement) {
            statusElement.textContent = "No records found";
          }
          if (searchButton) searchButton.disabled = false;
          searchInProgress = false;
          return;
        }
        
        // Convert results to matchedRecords format
        // Store full record object for PDF generation (especially for Shovels API records)
        allRecords = results.map(rec => {
          const recId = rec.record_id || (() => {
            const candidates = ["PermitNumber", "PermitNum", "_id", "ID", "OBJECTID", "FID", "ApplicationNumber"];
            for (const candidate of candidates) {
              if (rec[candidate]) {
                return String(rec[candidate]);
              }
            }
            return "unknown";
          })();
          
          // Store full record object, but also add convenience fields for display
          return {
            // Full original record (needed for PDF generation, especially Shovels API)
            ...rec,
            // Convenience fields for display/access
            record_id: recId,
            permit_number: rec.permit_number || rec.PermitNumber || rec.PermitNum || recId,
            address: rec.address || rec.SearchAddress || rec.OriginalAddress1 || rec.AddressDescription || rec.Address || "Address not available",
            city: rec.city || rec.OriginalCity || rec.City || "",
            zip: rec.zip || rec.OriginalZip || rec.ZipCode || "",
            work_description: rec.work_description || rec.WorkDescription || rec.ProjectDescription || rec.Description || "",
            status: rec.status || rec.StatusCurrentMapped || rec.CurrentStatus || "",
            applied_date: rec.applied_date || rec.AppliedDate || rec.ApplicationDate || ""
          };
        });

        matchedRecords = allRecords; // keep legacy reference

        // Apply unit filter (client-side)
        applyUnitFilter();
        
        // Update display with all results
        updateResultsDisplay();
        
        // Update status message in results card
        const statusElement = document.getElementById("resultsStatus");
        if (statusElement) {
          if (displayedRecords.length === 0) {
            statusElement.textContent = "No records found";
          } else {
            // Header is updated in updateResultsDisplay
            statusElement.textContent = `Found ${displayedRecords.length} record(s)`;
          }
        }
        
        searchInProgress = false;
        setStatus(`Search complete: ${displayedRecords.length} record(s) found`);
        if (searchButton) searchButton.disabled = false;
        // Form fields already cleared when search was submitted
        
      } catch (err) {
        searchInProgress = false;
        const em = (err && err.message) ? err.message : String(err);
        setStatus(`Search error: ${em}`, true);
        const statusElement = document.getElementById("resultsStatus");
        if (statusElement) {
          statusElement.textContent = `Error: ${em}`;
        }
        if (searchButton) searchButton.disabled = false;
      }
    }
    
    // Use regular /search endpoint (not streaming)
    await fallbackToRegularSearch(url);
    
    console.debug("[search] total elapsed ms:", Math.round(performance.now() - t0));
  }

  function pick_id_from_record(rec) {
    const candidates = ["PermitNumber", "PermitNum", "_id", "ID", "OBJECTID", "FID", "ApplicationNumber"];
    for (const candidate of candidates) {
      if (rec[candidate]) {
        return String(rec[candidate]);
      }
    }
    return "unknown";
  }

  function updateResultsDisplay() {
    // Re-apply filter before rendering (handles toggle changes)
    applyUnitFilter();

    console.log("[updateResultsDisplay] Updating display with", displayedRecords.length, "records (all:", allRecords.length, ", unit:", unitFilteredRecords.length, ")");
    const cardsContainer = document.getElementById("resultsCards");
    const countElement = document.getElementById("recordCount");
    const statusElement = document.getElementById("resultsStatus");
    
    if (!cardsContainer) {
      console.error("[updateResultsDisplay] resultsCards container not found!");
      return;
    }
    
    // Update status message
    if (statusElement) {
      const unitActive = !!activeUnitNumber;
      const noUnitMatches = unitActive && unitFilteredRecords.length === 0 && allRecords.length > 0;

      if (displayedRecords.length === 0) {
        statusElement.textContent = "Searching...";
      } else if (unitActive && !showAllBuildingPermits && unitFilteredRecords.length > 0) {
        statusElement.textContent = `Showing ${displayedRecords.length} permit(s) for Unit ${activeUnitNumber}`;
      } else if (unitActive && showAllBuildingPermits) {
        statusElement.textContent = `Showing all ${displayedRecords.length} building permit(s) (Unit ${activeUnitNumber} filter off)`;
      } else if (noUnitMatches) {
        statusElement.textContent = `No permits found for Unit ${activeUnitNumber}. Showing all ${displayedRecords.length} building permit(s)`;
      } else {
        statusElement.textContent = `Found ${displayedRecords.length} record(s)`;
      }
    }
    
    // Update count (hidden element for reference)
    if (countElement) {
      countElement.textContent = displayedRecords.length;
    }

    // Inject toggle UI if unit is active
    const header = document.getElementById("resultsHeader");
    if (header) {
      const existing = document.getElementById("unitFilterControls");
      if (existing) existing.remove();

      if (activeUnitNumber) {
        const controls = document.createElement("div");
        controls.id = "unitFilterControls";
        controls.style.cssText = "margin-top:10px; font-size:12px; color:#374151;";
        const unitCount = unitFilteredRecords.length;
        const totalCount = allRecords.length;
        const canToggle = totalCount > 0;
        controls.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:center; gap:10px; flex-wrap:wrap;">
            <span style="font-weight:600;">Unit filter:</span>
            <span>Unit ${safeText(activeUnitNumber)} matched ${unitCount} / ${totalCount}</span>
            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;">
              <input id="showAllPermitsToggle" type="checkbox" ${showAllBuildingPermits ? "checked" : ""} ${canToggle ? "" : "disabled"} />
              Show all building permits
            </label>
          </div>
        `;
        header.appendChild(controls);

        const toggle = document.getElementById("showAllPermitsToggle");
        if (toggle) {
          toggle.addEventListener("change", () => {
            showAllBuildingPermits = !!toggle.checked;
            updateResultsDisplay();
          });
        }
      }
    }
    
    // Render displayed cards
    cardsContainer.innerHTML = displayedRecords.map((record, index) => {
      const address = record.address || "Address not available";
      const city = record.city ? `, ${record.city}` : "";
      const zip = record.zip ? ` ${record.zip}` : "";
      const fullAddress = `${address}${city}${zip}`;
      const permitNum = record.permit_number || record.record_id || "N/A";
      const description = record.work_description || "No description available";
      const status = record.status || "";
      const appliedDate = record.applied_date || "";
      
      return `
        <div class="record-card" 
             data-record-id="${record.record_id}" 
             data-permit-number="${permitNum}"
             style="
               background: #fff;
               padding: 16px;
               border-radius: 10px;
               border: 1px solid #e5e7eb;
               box-shadow: 0 4px 12px rgba(0,0,0,0.1);
               cursor: pointer;
               transition: all 0.2s;
               margin-bottom: 0;
             "
             onmouseover="this.style.boxShadow='0 6px 16px rgba(0,0,0,0.15)'; this.style.transform='translateY(-2px)'"
             onmouseout="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.1)'; this.style.transform='translateY(0)'"
             onclick="window.selectRecordForPDF(${index})">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
            <div style="flex: 1; min-width: 0;">
              <h4 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 700; color: #111827;">
                ${safeText(permitNum)}
              </h4>
              <div style="color: #374151; font-size: 14px; margin-bottom: 10px; line-height: 1.5;">
                <strong>Address:</strong> ${safeText(fullAddress)}
              </div>
              <div style="color: #6b7280; font-size: 13px; margin-bottom: 10px; line-height: 1.4;">
                <strong>Description:</strong> ${safeText(description.substring(0, 150))}${description.length > 150 ? '...' : ''}
              </div>
              <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px;">
                ${status ? `<span style="background: #f3f4f6; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 600;">${safeText(status)}</span>` : ""}
                ${appliedDate ? `<span style="background: #f3f4f6; padding: 4px 8px; border-radius: 6px; font-size: 12px;">Applied: ${safeText(appliedDate)}</span>` : ""}
              </div>
            </div>
            <div style="display: flex; align-items: center;">
              <button style="
                padding: 8px 16px;
                background: #2563eb;
                color: #fff;
                border: none;
                border-radius: 8px;
                font-weight: 600;
                font-size: 14px;
                cursor: pointer;
              ">Generate PDF</button>
            </div>
          </div>
        </div>
      `;
    }).join("");
  }

  window.selectRecordForPDF = async function selectRecordForPDF(index) {
    // use displayed list so PDF respects unit filtering view
    const record = displayedRecords[index];
    if (!record) {
      console.error("[selectRecordForPDF] Record not found at index", index);
      return;
    }
    
    console.log("[selectRecordForPDF] Generating PDF for record:", record);
    setStatus("Generating PDF...");
    
    try {
      // Send full record object to backend (especially important for Shovels API records)
      // Backend will use this directly instead of re-querying the database/API
      const requestBody = {
        record_id: record.record_id,
        permit_number: record.permit_number,
        record: record,  // Send full record object - backend will use this if provided
        unit_number: activeUnitNumber || ""  // optional context for certificate
      };
      
      console.log("[selectRecordForPDF] Request body:", requestBody);
      console.log("[selectRecordForPDF] API URL:", `${API_BASE_URL}/generate-pdf`);
      
      const response = await fetch(`${API_BASE_URL}/generate-pdf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });
      
      console.log("[selectRecordForPDF] Response status:", response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error("[selectRecordForPDF] Error response:", errorText);
        throw new Error(`Server returned ${response.status}: ${errorText}`);
      }
      
      const data = await response.json();
      console.log("[selectRecordForPDF] Response data:", data);
      
      if (data.success && data.view_url) {
        setStatus("PDF generated successfully!");
        // Open PDF in new tab - ensure full URL
        const fullUrl = data.view_url.startsWith('http') ? data.view_url : `${API_BASE_URL}${data.view_url}`;
        console.log("[selectRecordForPDF] Opening PDF URL:", fullUrl);
        window.open(fullUrl, '_blank');
      } else {
        throw new Error(data.error || data.detail || "PDF generation failed");
      }
    } catch (error) {
      console.error("[selectRecordForPDF] Error:", error);
      setStatus(`Error generating PDF: ${error.message}`, true);
      alert(`Error generating PDF: ${error.message}`);
    }
  }
  
  // Close results modal and empty all fields
  window.closeResults = function closeResults() {
    console.log("[closeResults] ===== CLOSE BUTTON CLICKED =====");
    const resultsDiv = document.getElementById("results");
    if (resultsDiv) {
      resultsDiv.style.display = "none";
      console.log("[closeResults] Results modal hidden");
    }
    matchedRecords = [];
    searchInProgress = false;
    setStatus("Ready.");
    
    // Empty all form fields when user clicks close button
    console.log("[closeResults] Calling emptyAllFields()...");
    try {
      emptyAllFields();
      console.log("[closeResults] emptyAllFields() completed");
    } catch (e) {
      console.error("[closeResults] Error calling emptyAllFields():", e);
    }
  }

  window.resetSearch = function resetSearch() {
    matchedRecords = [];
    searchInProgress = false;
    const resultsDiv = document.getElementById("results");
    if (resultsDiv) {
      resultsDiv.style.display = "none";
      const resultsContent = document.getElementById("resultsContent");
      if (resultsContent) {
        resultsContent.innerHTML = "";
      }
    }
    setStatus("Ready.");
    emptyAllFields();
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

    // Initialize autocomplete when both DOM and Google Maps are ready
    function tryInitAutocomplete() {
      if (window.google && window.google.maps && window.google.maps.places) {
        try { 
          initAutocompleteSafe(); 
          console.log("Autocomplete initialized successfully");
        } catch(e) { 
          console.warn("initAutocomplete failed:", e); 
        }
      } else {
        // If Google Maps isn't ready yet, wait a bit and try again
        setTimeout(tryInitAutocomplete, 100);
      }
    }
    
    // Store the internal init function so the global callback can use it
    window._initAutocompleteInternal = tryInitAutocomplete;
    
    // Update the global callback to actually initialize (if called again)
    window.initAutocomplete = function() {
      console.log("initAutocomplete callback called");
      tryInitAutocomplete();
    };
    
    // Try immediately in case Google Maps already loaded
    tryInitAutocomplete();

    // Removed permit-only auto lookup; address is required for search

    if (searchForm) {
      // Remove any existing action or method that might cause navigation
      searchForm.setAttribute("action", "javascript:void(0);");
      searchForm.setAttribute("method", "get");
      
      // Add form submit handler
      searchForm.addEventListener("submit", async (ev) => {
        console.log("[form] Submit event triggered!");
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        
        // Prevent any default form behavior
        if (ev.defaultPrevented) {
          console.log("[form] Event already prevented, returning");
          return;
        }
        
        console.log("[form] Processing form submission...");
        
        const city = cityInput ? cityInput.value.trim() : "";
        const permit = permitInput ? permitInput.value.trim() : "";
        const address = addressInput ? addressInput.value.trim() : "";
        const df = dateFrom ? dateFrom.value : "";
        const dt = dateTo ? dateTo.value : "";

        // Address is mandatory
        if (!address) { 
          setStatus("Property Address is required.", true); 
          return false; 
        }

        // Build search URL - NO scan_limit parameter (not used by backend)
        const params = new URLSearchParams();
        params.append("address", address);
        if (city) params.append("city", city);
        if (permit) params.append("permit", permit);
        if (df) params.append("date_from", df);
        if (dt) params.append("date_to", dt);
        params.append("max_results", "500");
        // include structured address parts - prefer manually entered values over Google parsed values
        // This allows users to edit sub-fields even after Google autocomplete, or fill them manually
        const addrNumberEl = document.getElementById("addr_number");
        const addrNameEl = document.getElementById("addr_name");
        const addrTypeEl = document.getElementById("addr_type");
        const addrZipEl = document.getElementById("addr_zip");
        
        const manualStreetNumber = addrNumberEl ? addrNumberEl.value.trim() : "";
        const manualStreetName = addrNameEl ? addrNameEl.value.trim() : "";
        const manualStreetType = addrTypeEl ? addrTypeEl.value.trim() : "";
        const manualZip = addrZipEl ? addrZipEl.value.trim() : "";
        
        // Use manually entered values if provided, otherwise fall back to Google parsed values
        let streetNumber = manualStreetNumber;
        let streetName = manualStreetName;
        let streetType = manualStreetType;
        let streetDir = "";
        let zip = manualZip;
        
        // If manual values not provided, try to get from Google parsed data
        if (!streetNumber || !streetName || !zip) {
        try {
          const parsed = addressInput && addressInput.dataset && addressInput.dataset.parsed ? JSON.parse(addressInput.dataset.parsed) : null;
            if (parsed) {
              if (!streetNumber && parsed.street_number) streetNumber = parsed.street_number;
              if (!streetName && parsed.street_name) streetName = parsed.street_name;
              if (!streetType && parsed.street_type) streetType = parsed.street_type;
              if (parsed.street_dir) streetDir = parsed.street_dir;
              if (!zip && parsed.postal_code) zip = parsed.postal_code;
            }
          } catch (e) { 
            console.debug("Error parsing Google address data:", e);
          }
        }
        
          console.log("[search] params (pre-url):", {
          address, city, df, dt,
          manual: { streetNumber, streetName, streetType, zip },
          streetDir
        });
        
        // Note: Removed street_number_q, street_name_q, street_type_q, street_dir_q, zip_q
        // Shovels API only needs the address string, not individual components

        const url = `${API_BASE}/search?${params.toString()}`;
        console.log("[search] url:", url);
        console.log("[search] Starting search - page should NOT navigate");
        
        // Clear form fields immediately after values are read and URL is built
        // Clear synchronously so user sees empty fields right away
        clearFormFields();
        
        try {
          // Use regular search - form already cleared above
          // This will display results on the same page without navigation
          await fetchAndRenderSearch(url);
        } catch (error) {
          console.error("[search] Error during search:", error);
          setStatus(`Search error: ${error.message}`, true);
          if (searchButton) searchButton.disabled = false;
        }
        
        return false; // Prevent any form submission
      }, true); // Use capture phase to ensure we catch it first
      
      console.log("[DOMContentLoaded] Form submit handler attached successfully");
      
      // Also add direct button click handler as backup
      if (searchButton) {
        searchButton.addEventListener("click", async function(ev) {
          console.log("[button] Search button clicked directly");
          ev.preventDefault();
          ev.stopPropagation();
          
          // Manually trigger form submission by calling the handler logic directly
          const city = cityInput ? cityInput.value.trim() : "";
          const permit = permitInput ? permitInput.value.trim() : "";
          const address = addressInput ? addressInput.value.trim() : "";
          const df = dateFrom ? dateFrom.value : "";
          const dt = dateTo ? dateTo.value : "";

          if (!address) {
            setStatus("Property Address is required.", true);
            return;
          }

          // Build search URL
          const params = new URLSearchParams();
          params.append("address", address);
          if (city) params.append("city", city);
          if (permit) params.append("permit", permit);
          if (df) params.append("date_from", df);
          if (dt) params.append("date_to", dt);
          params.append("max_results", "500");
          
          const addrNumberEl = document.getElementById("addr_number");
          const addrNameEl = document.getElementById("addr_name");
          const addrTypeEl = document.getElementById("addr_type");
          const addrZipEl = document.getElementById("addr_zip");
          
          const manualStreetNumber = addrNumberEl ? addrNumberEl.value.trim() : "";
          const manualStreetName = addrNameEl ? addrNameEl.value.trim() : "";
          const manualStreetType = addrTypeEl ? addrTypeEl.value.trim() : "";
          const manualZip = addrZipEl ? addrZipEl.value.trim() : "";
          
          let streetNumber = manualStreetNumber;
          let streetName = manualStreetName;
          let streetType = manualStreetType;
          let streetDir = "";
          let zip = manualZip;
          
          if (!streetNumber || !streetName || !zip) {
            try {
              const parsed = addressInput && addressInput.dataset && addressInput.dataset.parsed ? JSON.parse(addressInput.dataset.parsed) : null;
              if (parsed) {
                if (!streetNumber && parsed.street_number) streetNumber = parsed.street_number;
                if (!streetName && parsed.street_name) streetName = parsed.street_name;
                if (!streetType && parsed.street_type) streetType = parsed.street_type;
                if (parsed.street_dir) streetDir = parsed.street_dir;
                if (!zip && parsed.postal_code) zip = parsed.postal_code;
              }
            } catch (e) {
              console.debug("Error parsing Google address data:", e);
            }
          }
          
          // Note: Removed street_number_q, street_name_q, street_type_q, street_dir_q, zip_q
          // Shovels API only needs the address string, not individual components

          const url = `${API_BASE}/search?${params.toString()}`;
          console.log("[button] Starting search with URL:", url);
          
          // Clear form fields immediately after values are read and URL is built
          // Clear synchronously so user sees empty fields right away
          clearFormFields();
          
          try {
            await fetchAndRenderSearch(url);
          } catch (error) {
            console.error("[button] Error during search:", error);
            setStatus(`Search error: ${error.message}`, true);
            if (searchButton) searchButton.disabled = false;
          }
        });
        console.log("[DOMContentLoaded] Button click handler attached");
      }
      
      // Button click will naturally trigger form submit, which is handled above
    } else {
      console.error("[DOMContentLoaded] searchForm not found - cannot attach handlers!");
    }
  });
})();
