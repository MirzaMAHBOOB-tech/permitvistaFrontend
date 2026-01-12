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

  // Function to clear all form fields
  function clearFormFields() {
    console.log("[form] Starting to clear all fields...");
    
    // First, try form.reset() which is the most reliable way
    const searchForm = document.getElementById("searchForm");
    if (searchForm) {
      try {
        searchForm.reset();
        console.log("[form] Form reset() called");
      } catch (e) {
        console.warn("[form] Form reset() failed:", e);
      }
    }
    
    // Then manually clear each field to be absolutely sure
    const addressInput = document.getElementById("addressInput");
    const cityInput = document.getElementById("cityInput");
    const permitInput = document.getElementById("permitInput");
    const dateFrom = document.getElementById("dateFrom");
    const dateTo = document.getElementById("dateTo");
    const addrNumber = document.getElementById("addr_number");
    const addrName = document.getElementById("addr_name");
    const addrType = document.getElementById("addr_type");
    const addrZip = document.getElementById("addr_zip");
    
    // Clear address input
    if (addressInput) {
      addressInput.value = "";
      if (addressInput.dataset) {
        addressInput.dataset.parsed = "";
        delete addressInput.dataset.parsed;
      }
      // Trigger input event to ensure UI updates
      addressInput.dispatchEvent(new Event('input', { bubbles: true }));
      console.log("[form] Address cleared, value is now:", addressInput.value);
    }
    
    // Clear city
    if (cityInput) {
      cityInput.value = "";
      cityInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    // Clear permit
    if (permitInput) {
      permitInput.value = "";
      permitInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    // Clear dates
    if (dateFrom) {
      dateFrom.value = "";
      dateFrom.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (dateTo) {
      dateTo.value = "";
      dateTo.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    // Clear address sub-fields
    if (addrNumber) {
      addrNumber.value = "";
      addrNumber.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (addrName) {
      addrName.value = "";
      addrName.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (addrType) {
      addrType.value = "";
      addrType.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (addrZip) {
      addrZip.value = "";
      addrZip.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    console.log("[form] All fields cleared successfully");
  }

  // Store matched records
  let matchedRecords = [];
  let searchInProgress = false;

  async function fetchAndRenderSearch(url) {
    console.log("[fetchAndRenderSearch] Starting search with URL:", url);
    const resultsDiv = document.getElementById("results");
    const searchButton = document.getElementById("searchButton");
    const resetButton = document.getElementById("resetButton");
    
    if (!resultsDiv) {
      console.error("[fetchAndRenderSearch] Results div not found!");
      setStatus("Error: Results container not found", true);
      return;
    }
    
    // Reset previous results
    matchedRecords = [];
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
    if (resetButton) resetButton.style.display = "none";
    
    const t0 = performance.now();
    
    // Use streaming search endpoint for incremental results
    try {
      // Replace /search with /search-stream for incremental results
      const streamUrl = url.replace("/search?", "/search-stream?");
      console.log("[fetchAndRenderSearch] Using streaming endpoint:", streamUrl);
      
      const eventSource = new EventSource(streamUrl);
      let streamActive = true;
      
      eventSource.onmessage = function(event) {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'record') {
            // Add record to matched records immediately
            matchedRecords.push(data.data);
            updateResultsDisplay();
            console.log("[fetchAndRenderSearch] Received record", data.count);
          } else if (data.type === 'complete') {
            eventSource.close();
            streamActive = false;
            searchInProgress = false;
            
            // Update final status
            const statusElement = document.getElementById("resultsStatus");
            if (statusElement) {
              if (matchedRecords.length === 0) {
                statusElement.textContent = "No records found";
              } else {
                statusElement.textContent = `Found ${data.total} record(s)`;
              }
            }
            
            setStatus(`Search complete: ${data.total} record(s) found`);
            if (searchButton) searchButton.disabled = false;
            if (resetButton) resetButton.style.display = "inline-block";
            console.log("[fetchAndRenderSearch] Stream complete, total:", data.total);
          } else if (data.type === 'error') {
            eventSource.close();
            streamActive = false;
            searchInProgress = false;
            setStatus(`Error: ${data.message}`, true);
            const statusElement = document.getElementById("resultsStatus");
            if (statusElement) {
              statusElement.textContent = `Error: ${data.message}`;
            }
            if (searchButton) searchButton.disabled = false;
          }
        } catch (e) {
          console.error("Error parsing SSE data:", e);
        }
      };
      
      eventSource.onerror = function(error) {
        if (streamActive) {
          console.warn("[fetchAndRenderSearch] SSE error, falling back to regular search:", error);
          eventSource.close();
          streamActive = false;
          // Fallback to regular search
          fallbackToRegularSearch(url);
        }
      };
      
      // Set timeout to fallback if SSE doesn't work
      setTimeout(() => {
        if (streamActive && matchedRecords.length === 0) {
          console.warn("[fetchAndRenderSearch] SSE timeout, falling back to regular search");
          eventSource.close();
          streamActive = false;
          fallbackToRegularSearch(url);
        }
      }, 5000);
      
      return; // Exit early if SSE is working
    } catch (sseError) {
      console.warn("[fetchAndRenderSearch] EventSource not supported, using regular search:", sseError);
      // Fall through to regular search
    }
    
    // Fallback to regular search if SSE fails
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
        matchedRecords = results.map(rec => {
          const recId = rec.record_id || (() => {
            const candidates = ["PermitNumber", "PermitNum", "_id", "ID", "OBJECTID", "FID", "ApplicationNumber"];
            for (const candidate of candidates) {
              if (rec[candidate]) {
                return String(rec[candidate]);
              }
            }
            return "unknown";
          })();
          
          return {
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
        
        // Update display with all results
        updateResultsDisplay();
        
        // Update status message in results card
        const statusElement = document.getElementById("resultsStatus");
        if (statusElement) {
          if (matchedRecords.length === 0) {
            statusElement.textContent = "No records found";
          } else {
            statusElement.textContent = `Found ${matchedRecords.length} record(s)`;
          }
        }
        
        searchInProgress = false;
        setStatus(`Search complete: ${matchedRecords.length} record(s) found`);
        if (searchButton) searchButton.disabled = false;
        if (resetButton) resetButton.style.display = "inline-block";
        
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
    
    // Call fallback if we reach here
    fallbackToRegularSearch(url);
      
    } catch (err) {
      searchInProgress = false;
      const em = (err && err.message) ? err.message : String(err);
      setStatus(`Search error: ${em}`, true);
      if (resultsDiv) {
        resultsDiv.innerHTML = `<p style="color:#dc2626">Search error: ${em}</p>`;
      }
      if (searchButton) searchButton.disabled = false;
    } finally {
      console.debug("[search] total elapsed ms:", Math.round(performance.now() - t0));
    }
  }

  async function fallbackToRegularSearch(url) {
    const resultsDiv = document.getElementById("results");
    const searchButton = document.getElementById("searchButton");
    const resetButton = document.getElementById("resetButton");
    
    try {
      setStatus("Searching...");
      
      // Use regular search endpoint (no streaming)
      const response = await fetch(url, {
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
        if (resultsDiv) {
          resultsDiv.innerHTML = `<p style="color:#dc2626">Error: ${data.error}</p>`;
        }
        if (searchButton) searchButton.disabled = false;
        return;
      }
      
      const results = data.results || [];
      
      // Convert results to matchedRecords format
      matchedRecords = results.map(rec => ({
        record_id: rec.record_id || pick_id_from_record(rec),
        permit_number: rec.permit_number || rec.PermitNumber || rec.PermitNum || rec.record_id,
        address: rec.address || rec.SearchAddress || rec.OriginalAddress1 || rec.AddressDescription || "Address not available",
        city: rec.city || rec.OriginalCity || rec.City || "",
        zip: rec.zip || rec.OriginalZip || rec.ZipCode || "",
        work_description: rec.work_description || rec.WorkDescription || rec.ProjectDescription || rec.Description || "",
        status: rec.status || rec.StatusCurrentMapped || rec.CurrentStatus || "",
        applied_date: rec.applied_date || rec.AppliedDate || rec.ApplicationDate || ""
      }));
      
      // Update display
      updateResultsDisplay();
      
      searchInProgress = false;
      setStatus(`Search complete: ${matchedRecords.length} record(s) found`);
      if (searchButton) searchButton.disabled = false;
      if (resetButton) resetButton.style.display = "inline-block";
      
    } catch (err) {
      searchInProgress = false;
      const em = (err && err.message) ? err.message : String(err);
      setStatus(`Search error: ${em}`, true);
      if (resultsDiv) {
        resultsDiv.innerHTML = `<p style="color:#dc2626">Search error: ${em}</p>`;
      }
      if (searchButton) searchButton.disabled = false;
    }
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
    console.log("[updateResultsDisplay] Updating display with", matchedRecords.length, "records");
    const cardsContainer = document.getElementById("resultsCards");
    const countElement = document.getElementById("recordCount");
    const statusElement = document.getElementById("resultsStatus");
    
    if (!cardsContainer) {
      console.error("[updateResultsDisplay] resultsCards container not found!");
      return;
    }
    
    // Update status message
    if (statusElement) {
      if (matchedRecords.length === 0) {
        statusElement.textContent = "Searching...";
      } else {
        statusElement.textContent = `Found ${matchedRecords.length} record(s)`;
      }
    }
    
    // Update count (hidden element for reference)
    if (countElement) {
      countElement.textContent = matchedRecords.length;
    }
    
    // Render all cards
    cardsContainer.innerHTML = matchedRecords.map((record, index) => {
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
    const record = matchedRecords[index];
    if (!record) {
      console.error("[selectRecordForPDF] Record not found at index", index);
      return;
    }
    
    console.log("[selectRecordForPDF] Generating PDF for record:", record);
    setStatus("Generating PDF...");
    
    try {
      const requestBody = {
        record_id: record.record_id,
        permit_number: record.permit_number
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
  
  window.closeResults = function closeResults() {
    console.log("[closeResults] Closing results");
    const resultsDiv = document.getElementById("results");
    if (resultsDiv) {
      resultsDiv.style.display = "none";
    }
    matchedRecords = [];
    searchInProgress = false;
    setStatus("Ready.");
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
    const resetButton = document.getElementById("resetButton");
    if (resetButton) resetButton.style.display = "none";
    setStatus("Ready.");
    clearFormFields();
  }
  
  window.closeResults = function closeResults() {
    console.log("[closeResults] Closing results");
    const resultsDiv = document.getElementById("results");
    if (resultsDiv) {
      resultsDiv.style.display = "none";
    }
    matchedRecords = [];
    searchInProgress = false;
    setStatus("Ready.");
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
        
        // Add structured address parts to search params if available
        if (streetNumber) params.append("street_number_q", streetNumber);
        if (streetName) params.append("street_name_q", streetName);
        if (streetType) params.append("street_type_q", streetType);
        if (streetDir) params.append("street_dir_q", streetDir);
        if (zip) params.append("zip_q", zip);

        const url = `${API_BASE}/search?${params.toString()}`;
        console.log("[search] url:", url);
        console.log("[search] Starting search - page should NOT navigate");
        
        try {
          // Use regular search (don't clear form - user might want to search again)
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
          
          if (streetNumber) params.append("street_number_q", streetNumber);
          if (streetName) params.append("street_name_q", streetName);
          if (streetType) params.append("street_type_q", streetType);
          if (streetDir) params.append("street_dir_q", streetDir);
          if (zip) params.append("zip_q", zip);

          const url = `${API_BASE}/search?${params.toString()}`;
          console.log("[button] Starting search with URL:", url);
          
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

    // Setup reset button click handler
    const resetButton = document.getElementById("resetButton");
    if (resetButton) {
      resetButton.addEventListener("click", function() {
        if (typeof window.resetSearch === 'function') {
          window.resetSearch();
        }
      });
    }
  });
})();
