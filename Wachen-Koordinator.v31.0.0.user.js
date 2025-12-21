// ==UserScript==
// @name         LSS - Koordinator (Custom Timings V31)
// @namespace    http://tampermonkey.net/
// @version      31.0
// @description  Vollautomat. Jetzt mit einstellbaren Wartezeiten (Klick & Move) im UI.
// @author       B&M
// @match        https://www.leitstellenspiel.de/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

(function() {
    'use strict';

    // --- DEFAULTS ---
    const DEFAULT_CONFIG = {
        startLat: 54.881476,
        startLon: 7.747385,
        distance: 8,
        maxCols: 20,
        failLimit: 10,
        plzAllow: "2",
        plzBlock: "26",
        waitClick: 1500, // NEU: Standard Wartezeit nach Klick
        waitMove: 1200   // NEU: Standard Wartezeit nach Verschieben
    };

    const MAX_EMPTY_RETRIES = 4;

    // --- GLOBALS ---
    let autoLoopActive = false;
    let consecutiveFails = 0;
    let isBusy = false;
    let lastProcessedAddress = "";
    let emptyAddressRetries = 0;
    let currentConfig = Object.assign({}, DEFAULT_CONFIG);
    let configLoaded = false;

    // Initial Config Load
    loadConfig().then(() => {
        configLoaded = true;
    });

    // --- MAIN LOOP ---
    setInterval(function() {
        try {
            const poiInput = document.getElementById('mission_position_address');
            const buildingInput = document.getElementById('building_address');
            const activeInput = poiInput || buildingInput;
            const panel = document.getElementById('wachen-koordinator');

            if (activeInput && !panel && configLoaded) {
                createAndInjectUI();
            }
            else if (!activeInput && panel) {
                panel.remove();
                autoLoopActive = false;
                isBusy = false;
            }

            if (panel && activeInput) {
                const targetBtn = findAnyBuildButton();
                const map = unsafeWindow.map;
                const marker = findBuildingMarker(map);

                updateCloneButtonState(targetBtn);
                updateAutoButtonState(targetBtn, marker);

                if (autoLoopActive && !isBusy) {
                    performAutoLoopStep(targetBtn, marker, activeInput);
                }
            }
        } catch (e) {
            console.error("LSS Koordinator Loop Fehler:", e);
        }
    }, 500);


    // --- ASYNC LOGIC WRAPPER ---

    async function performAutoLoopStep(targetBtn, marker, addressInput) {
        const statusDiv = document.getElementById('auto-status');

        if (!marker || !targetBtn) {
            if(statusDiv) statusDiv.innerText = "Warte auf Ziel...";
            return;
        }

        const currentAddress = addressInput ? addressInput.value.trim() : "";

        // Ocean Fix Logic
        if (currentAddress === "") {
            emptyAddressRetries++;
            if (emptyAddressRetries < MAX_EMPTY_RETRIES) {
                if(statusDiv) statusDiv.innerText = "Lade... (" + emptyAddressRetries + ")";
                return;
            } else {
                if(statusDiv) statusDiv.innerText = "Keine Adresse (Wasser?)";
            }
        } else {
            emptyAddressRetries = 0;
            if (currentAddress === lastProcessedAddress) {
                if(statusDiv) statusDiv.innerText = "Warte auf Update...";
                return;
            }
        }

        isBusy = true;

        const checkResult = checkAddressQuality(currentAddress);

        if (checkResult.valid) {
            if(statusDiv) statusDiv.innerHTML = '<span style="color:#4CAF50">OK: ' + checkResult.plz + '</span>';
            consecutiveFails = 0;
            lastProcessedAddress = currentAddress;

            targetBtn.click();

            // Wartezeit aus Config nutzen
            setTimeout(function() {
                finishMoveStep();
            }, currentConfig.waitClick);

        } else {
            consecutiveFails++;
            const limit = currentConfig.failLimit;
            if(statusDiv) statusDiv.innerHTML = '<span style="color:orange">' + checkResult.reason + ' (' + consecutiveFails + '/' + limit + ')</span>';

            if (consecutiveFails >= limit) {
                if(statusDiv) statusDiv.innerHTML = '<span style="color:red">Next Row (Limit)</span>';
                lastProcessedAddress = "";
                emptyAddressRetries = 0;

                await advanceToNextRow(false);
                setTimeout(function() {
                    finishMoveStep();
                }, 1000);
            } else {
                await setMarkerToNextCoordinate();
                // Wartezeit aus Config nutzen
                setTimeout(function() {
                    isBusy = false;
                }, currentConfig.waitMove);
            }
        }
    }

    async function finishMoveStep() {
        await setMarkerToNextCoordinate();
        // Wartezeit aus Config nutzen
        setTimeout(function() {
            isBusy = false;
            emptyAddressRetries = 0;
        }, currentConfig.waitMove);
    }


    // --- FINDER & UI UPDATER ---

    function findAnyBuildButton() {
        const candidates = document.querySelectorAll('input.btn-success[type="submit"]');
        for (let i = 0; i < candidates.length; i++) {
            const btn = candidates[i];
            if (btn.offsetWidth > 0 || btn.getClientRects().length > 0) {
                const text = btn.value.toLowerCase();
                if (text.includes('speichern') || text.includes('bauen')) {
                    return btn;
                }
            }
        }
        return null;
    }

    function updateCloneButtonState(targetBtn) {
        const cloneButton = document.getElementById('btn-clone-build');
        if (!cloneButton) return;

        if (targetBtn) {
            cloneButton.style.display = 'block';
            cloneButton.className = 'btn btn-success';
            cloneButton.innerText = targetBtn.value;
            cloneButton.onclick = function(e) {
                e.preventDefault();
                targetBtn.click();
            };
        } else {
            cloneButton.style.display = 'none';
        }
    }

    function updateAutoButtonState(targetBtn, marker) {
        const autoBtn = document.getElementById('btn-auto-toggle');
        const autoStatus = document.getElementById('auto-status');
        if (!autoBtn) return;

        if (targetBtn && marker) {
            autoBtn.disabled = false;
            autoBtn.style.opacity = "1";
            autoBtn.style.cursor = "pointer";
            if (!autoLoopActive && autoStatus.innerText.includes("Warte")) {
                autoStatus.innerText = "Bereit.";
            }
        } else {
            if (!autoLoopActive) {
                autoBtn.disabled = true;
                autoBtn.style.opacity = "0.4";
                autoBtn.style.cursor = "not-allowed";
                if(!marker) autoStatus.innerText = "Kein Marker.";
                else if(!targetBtn) autoStatus.innerText = "Warte auf Button.";
            }
        }
    }


    // --- CORE LOGIC ---

    async function loadConfig() {
        currentConfig.startLat = await GM_getValue('cfg_startLat', DEFAULT_CONFIG.startLat);
        currentConfig.startLon = await GM_getValue('cfg_startLon', DEFAULT_CONFIG.startLon);
        currentConfig.distance = await GM_getValue('cfg_distance', DEFAULT_CONFIG.distance);
        currentConfig.maxCols = await GM_getValue('cfg_maxCols', DEFAULT_CONFIG.maxCols);
        currentConfig.failLimit = await GM_getValue('cfg_failLimit', DEFAULT_CONFIG.failLimit);
        currentConfig.plzAllow = await GM_getValue('cfg_plzAllow', DEFAULT_CONFIG.plzAllow);
        currentConfig.plzBlock = await GM_getValue('cfg_plzBlock', DEFAULT_CONFIG.plzBlock);

        // Neue Zeit-Werte laden
        currentConfig.waitClick = await GM_getValue('cfg_waitClick', DEFAULT_CONFIG.waitClick);
        currentConfig.waitMove = await GM_getValue('cfg_waitMove', DEFAULT_CONFIG.waitMove);
    }

    function checkAddressQuality(address) {
        if (!address || address === "") return { valid: false, reason: "Leer" };
        const cleanAddr = address.trim();
        if (cleanAddr.indexOf(',') === -1) return { valid: false, reason: "Kein Komma" };

        const parts = cleanAddr.split(',');
        if (parts.length < 2) return { valid: false, reason: "Format Fehler" };
        const partBeforeComma = parts[0].trim();

        if (/^\d{5}/.test(partBeforeComma)) return { valid: false, reason: "Start mit PLZ" };
        if (partBeforeComma.length === 0) return { valid: false, reason: "Keine Straße" };

        const plzMatch = cleanAddr.match(/\b\d{5}\b/);
        if (!plzMatch) return { valid: false, reason: "Keine DE-PLZ" };

        const plz = plzMatch[0];

        const allowStr = currentConfig.plzAllow + "";
        const allowedPrefixes = allowStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
        if (allowedPrefixes.length > 0) {
            const isAllowed = allowedPrefixes.some(prefix => plz.startsWith(prefix));
            if (!isAllowed) return { valid: false, reason: "PLZ " + plz + " (Nicht erlaubt)" };
        }

        const blockStr = currentConfig.plzBlock + "";
        const blockedPrefixes = blockStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
        if (blockedPrefixes.length > 0) {
            const isBlocked = blockedPrefixes.some(prefix => plz.startsWith(prefix));
            if (isBlocked) return { valid: false, reason: "PLZ " + plz + " (Gesperrt)" };
        }

        return { valid: true, plz: plz };
    }

    // --- MAP OPERATIONS ---

    function findBuildingMarker(mapInstance) {
        let buildingMarker = null;
        if (!mapInstance) return null;
        mapInstance.eachLayer(function(layer) {
            if (layer.options && layer.options.draggable && layer._latlng) buildingMarker = layer;
        });
        return buildingMarker;
    }

    async function setMarkerToNextCoordinate() {
        const map = unsafeWindow.map;
        const marker = findBuildingMarker(map);
        if (!marker) return;

        let currentRow = await GM_getValue('currentRow', 0);
        let currentCol = await GM_getValue('currentCol', 0);

        const startPoint = { lat: currentConfig.startLat, lon: currentConfig.startLon };
        const dist = currentConfig.distance;
        const maxCols = currentConfig.maxCols;

        let rowStartPoint = startPoint;
        if (currentRow > 0) rowStartPoint = calculateDestinationPoint(rowStartPoint, dist * currentRow, 180);

        let targetPoint = calculateDestinationPoint(rowStartPoint, dist * currentCol, 90);

        const newLatLng = { lat: targetPoint.lat, lng: targetPoint.lon };
        marker.setLatLng(newLatLng);
        map.panTo(newLatLng);
        marker.fire('dragend');

        let nextCol = currentCol + 1;
        let nextRow = currentRow;

        if (nextCol >= maxCols) {
            nextCol = 0;
            nextRow = nextRow + 1;
        }

        await GM_setValue('currentCol', nextCol);
        await GM_setValue('currentRow', nextRow);

        updateStatusDisplay();
    }

    async function advanceToNextRow(isManual) {
        let currentRow = await GM_getValue('currentRow', 0);
        await GM_setValue('currentRow', currentRow + 1);
        await GM_setValue('currentCol', 0);
        consecutiveFails = 0;
        lastProcessedAddress = "";
        emptyAddressRetries = 0;
        updateStatusDisplay();
        if(isManual) await setMarkerToNextCoordinate();
    }

    function calculateDestinationPoint(startPoint, distanceKm, bearing) {
        const R = 6371;
        const lat1 = toRad(startPoint.lat);
        const lon1 = toRad(startPoint.lon);
        const brng = toRad(bearing);
        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distanceKm / R) + Math.cos(lat1) * Math.sin(distanceKm / R) * Math.cos(brng));
        const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(distanceKm / R) * Math.cos(lat1), Math.cos(distanceKm / R) - Math.sin(lat1) * Math.sin(lat2));
        return { lat: toDeg(lat2), lon: toDeg(lon2) };
    }

    function toRad(degrees) { return degrees * Math.PI / 180; }
    function toDeg(radians) { return radians * 180 / Math.PI; }


    // --- UI CREATION ---

    function createAndInjectUI() {
        const container = document.createElement('div');
        container.id = 'wachen-koordinator';
        document.body.appendChild(container);

        container.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                <h3 style="margin:0; font-size:14px;">Koordinator V31</h3>
                <button id="btn-toggle-settings" class="btn btn-xs btn-default">⚙️</button>
            </div>

            <div id="coord-status"></div>

            <div id="settings-area" style="display:none; background:#333; padding:5px; margin-bottom:10px; border:1px solid #555; border-radius:4px; text-align:left;">
                <label>Startpunkt (Lat/Lon):</label>
                <div style="display:flex; gap:2px;">
                    <input type="text" id="cfg-lat" style="width:50%; color:black;" value="${currentConfig.startLat}">
                    <input type="text" id="cfg-lon" style="width:50%; color:black;" value="${currentConfig.startLon}">
                </div>
                <button id="btn-get-center" class="btn btn-xs btn-info" style="margin-top:2px; margin-bottom: 5px;">Kartenmitte übernehmen</button>

                <div style="display:flex; gap:5px;">
                   <div style="width:33%">
                       <label>Abstand (km)</label>
                       <input type="number" id="cfg-dist" style="width:100%; color:black;" value="${currentConfig.distance}">
                   </div>
                   <div style="width:33%">
                       <label>Max. Spalten</label>
                       <input type="number" id="cfg-cols" style="width:100%; color:black;" value="${currentConfig.maxCols}">
                   </div>
                   <div style="width:33%">
                       <label>Max Fehler</label>
                       <input type="number" id="cfg-fail" style="width:100%; color:black;" value="${currentConfig.failLimit}">
                   </div>
                </div>

                <div style="display:flex; gap:5px; margin-top:5px;">
                   <div style="width:50%">
                       <label>Warte Klick (ms)</label>
                       <input type="number" id="cfg-wait-click" style="width:100%; color:black;" value="${currentConfig.waitClick}">
                   </div>
                   <div style="width:50%">
                       <label>Warte Move (ms)</label>
                       <input type="number" id="cfg-wait-move" style="width:100%; color:black;" value="${currentConfig.waitMove}">
                   </div>
                </div>

                <label style="margin-top:5px;">PLZ Erlaubt (Start):</label>
                <input type="text" id="cfg-plz-allow" style="width:100%; color:black;" value="${currentConfig.plzAllow}" placeholder="z.B. 2, 3">

                <label style="margin-top:2px;">PLZ Verboten (Start):</label>
                <input type="text" id="cfg-plz-block" style="width:100%; color:black;" value="${currentConfig.plzBlock}" placeholder="z.B. 26">

                <button id="btn-save-cfg" class="btn btn-success btn-xs" style="margin-top:8px; width:100%;">Speichern & Schließen</button>
            </div>

            <div id="auto-area">
                <div id="auto-status" style="font-size: 0.8em; color: #aaa; margin-bottom: 5px; min-height: 20px;">Initialisiere...</div>
                <button id="btn-auto-toggle" class="btn btn-danger" style="margin-bottom: 10px; opacity: 0.5;" disabled>AUTO STARTEN</button>
            </div>

            <button id="btn-clone-build" class="btn" style="display: none; margin-bottom: 10px; font-weight:bold; border: 2px solid white;"></button>

            <hr style="border-color: #555; margin: 5px 0 10px 0;">

            <div id="manual-controls">
                <button id="btn-set-marker" class="btn btn-default btn-xs">Marker manuell weiter</button>
                <div style="display: flex; gap: 2px; margin-top: 5px;">
                     <input type="number" id="manual-row" placeholder="R" style="width: 40px; color:black;">
                     <input type="number" id="manual-col" placeholder="C" style="width: 40px; color:black;">
                     <button id="btn-manual-save" class="btn btn-default btn-xs">Set</button>
                </div>
                <button id="btn-next-row" class="btn btn-warning btn-xs" style="margin-top:5px;">Nächste Reihe erzwingen</button>
                <button id="btn-reset-coords" class="btn btn-danger btn-xs" style="margin-top:5px;">Reset</button>
            </div>
        `;

        // Listeners
        document.getElementById('btn-set-marker').addEventListener('click', function() { setMarkerToNextCoordinate(); });
        document.getElementById('btn-next-row').addEventListener('click', function() { advanceToNextRow(true); });
        document.getElementById('btn-reset-coords').addEventListener('click', function() { resetProgress(); });
        document.getElementById('btn-manual-save').addEventListener('click', function() { setManualState(); });
        document.getElementById('btn-auto-toggle').addEventListener('click', function() { toggleAutoMode(); });

        document.getElementById('btn-toggle-settings').addEventListener('click', function() {
            const el = document.getElementById('settings-area');
            el.style.display = el.style.display === 'none' ? 'block' : 'none';
        });

        document.getElementById('btn-get-center').addEventListener('click', function() {
            const map = unsafeWindow.map;
            if(map) {
                const center = map.getCenter();
                document.getElementById('cfg-lat').value = center.lat.toFixed(6);
                document.getElementById('cfg-lon').value = center.lng.toFixed(6);
            }
        });

        document.getElementById('btn-save-cfg').addEventListener('click', async function() {
             const latInput = parseFloat(document.getElementById('cfg-lat').value);
            const lonInput = parseFloat(document.getElementById('cfg-lon').value);
            const distInput = parseFloat(document.getElementById('cfg-dist').value);
            const colsInput = parseInt(document.getElementById('cfg-cols').value);
            const failInput = parseInt(document.getElementById('cfg-fail').value);
            const plzAllowInput = document.getElementById('cfg-plz-allow').value;
            const plzBlockInput = document.getElementById('cfg-plz-block').value;

            // NEU: Zeiten speichern
            const waitClickInput = parseInt(document.getElementById('cfg-wait-click').value);
            const waitMoveInput = parseInt(document.getElementById('cfg-wait-move').value);

            if(!isNaN(latInput)) await GM_setValue('cfg_startLat', latInput);
            if(!isNaN(lonInput)) await GM_setValue('cfg_startLon', lonInput);
            if(!isNaN(distInput)) await GM_setValue('cfg_distance', distInput);
            if(!isNaN(colsInput)) await GM_setValue('cfg_maxCols', colsInput);
            if(!isNaN(failInput)) await GM_setValue('cfg_failLimit', failInput);
            await GM_setValue('cfg_plzAllow', plzAllowInput);
            await GM_setValue('cfg_plzBlock', plzBlockInput);

            // NEU: Zeiten sichern
            if(!isNaN(waitClickInput)) await GM_setValue('cfg_waitClick', waitClickInput);
            if(!isNaN(waitMoveInput)) await GM_setValue('cfg_waitMove', waitMoveInput);

            await loadConfig();

            const btn = document.getElementById('btn-save-cfg');
            btn.innerText = "Gespeichert!";
            setTimeout(function() {
                btn.innerText = "Speichern & Schließen";
                document.getElementById('settings-area').style.display = 'none';
            }, 800);
        });

        GM_addStyle(`
            #wachen-koordinator { position: fixed; bottom: 50px; right: 20px; z-index: 99999; background-color: #222; color: white; padding: 10px; border-radius: 8px; border: 2px solid #555; text-align: center; width: 220px; font-family: sans-serif; }
            #wachen-koordinator h3 { color: #ddd; }
            #wachen-koordinator button { width: 100%; margin-bottom: 3px; }
            #coord-status { font-weight: bold; color: #4CAF50; margin-bottom: 5px; }
            #settings-area label { font-size: 0.8em; color: #ccc; display:block; margin-bottom:1px; }
        `);

        updateStatusDisplay();
    }

    function toggleAutoMode() {
        autoLoopActive = !autoLoopActive;
        const btn = document.getElementById('btn-auto-toggle');
        const status = document.getElementById('auto-status');

        if (autoLoopActive) {
            btn.innerText = "AUTO STOPPEN";
            btn.className = "btn btn-success";
            status.innerText = "Start...";
            lastProcessedAddress = "";
        } else {
            btn.innerText = "AUTO STARTEN";
            btn.className = "btn btn-danger";
            status.innerText = "Pausiert.";
            isBusy = false;
        }
    }

    async function setManualState() {
        const row = parseInt(document.getElementById('manual-row').value);
        const col = parseInt(document.getElementById('manual-col').value);
        if (row) await GM_setValue('currentRow', row - 1);
        if (col) await GM_setValue('currentCol', col - 1);
        updateStatusDisplay();
    }

    function updateStatusDisplay() {
        const currentRow = GM_getValue('currentRow', 0);
        const currentCol = GM_getValue('currentCol', 0);
        const div = document.getElementById('coord-status');
        if (div) div.innerText = `R: ${currentRow + 1} | C: ${currentCol + 1}`;
    }

    async function resetProgress() {
        if (confirm('Reihen/Spalten Reset?')) {
            await GM_setValue('currentRow', 0);
            await GM_setValue('currentCol', 0);
            updateStatusDisplay();
        }
    }

})();
