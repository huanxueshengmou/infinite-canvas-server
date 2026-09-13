(() => {
    "use strict";
    const archive = JSON.parse(document.getElementById("infinite-canvas-archive").textContent);
    const viewport = document.getElementById("offline-viewport"), world = document.getElementById("offline-world"), level = document.getElementById("zoom-level");
    const assets = new Map(archive.assets.map((asset) => [asset.id, asset])), urls = new Map();
    let view = { x: 0, y: 0, k: 1 }, drag = null, space = false;
    const render = () => { world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`; level.textContent = `${Math.round(view.k * 100)}%`; };
    const zoom = (scale, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) => {
        const k = Math.min(5, Math.max(.05, scale));
        view = { x: x - (x - view.x) * k / view.k, y: y - (y - view.y) * k / view.k, k }; render();
    };
    const fit = () => {
        const nodes = Array.from(world.querySelectorAll(".node"));
        if (!nodes.length) { view = { x: 0, y: 0, k: 1 }; render(); return; }
        const left = Math.min(...nodes.map((node) => parseFloat(node.style.left))), top = Math.min(...nodes.map((node) => parseFloat(node.style.top)));
        const width = Math.max(...nodes.map((node) => parseFloat(node.style.left) + parseFloat(node.style.width))) - left;
        const height = Math.max(...nodes.map((node) => parseFloat(node.style.top) + parseFloat(node.style.height))) - top;
        const k = Math.min(1, Math.max(.05, Math.min((viewport.clientWidth - 64) / width, (viewport.clientHeight - 64) / height)));
        view = { x: (viewport.clientWidth - width * k) / 2 - left * k, y: (viewport.clientHeight - height * k) / 2 - top * k, k }; render();
    };
    document.getElementById("zoom-in").onclick = () => zoom(view.k * 1.25);
    document.getElementById("zoom-out").onclick = () => zoom(view.k / 1.25);
    document.getElementById("fit").onclick = fit;
    document.getElementById("theme-toggle").onclick = () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; };
    viewport.addEventListener("wheel", (event) => {
        if (event.target.closest(".scroll,video") && !event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const rect = viewport.getBoundingClientRect(); zoom(view.k * Math.exp(-event.deltaY * .002), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 && event.button !== 1 || event.target.closest("button,a,video") || !space && event.button === 0 && event.target.closest(".node:not(.group)")) return;
        event.preventDefault(); viewport.focus(); viewport.setPointerCapture(event.pointerId);
        drag = { id: event.pointerId, x: event.clientX - view.x, y: event.clientY - view.y }; viewport.classList.add("dragging");
    });
    viewport.addEventListener("pointermove", (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        view.x = event.clientX - drag.x; view.y = event.clientY - drag.y; render();
    });
    const stop = () => { drag = null; viewport.classList.remove("dragging"); };
    viewport.addEventListener("pointerup", stop); viewport.addEventListener("pointercancel", stop); viewport.addEventListener("lostpointercapture", stop);
    window.addEventListener("blur", () => { space = false; stop(); });
    window.addEventListener("keydown", (event) => {
        if (document.querySelector("dialog[open]")) return;
        if (event.code === "Space") { event.preventDefault(); space = true; }
        else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(view.k * 1.25); }
        else if (event.key === "-") { event.preventDefault(); zoom(view.k / 1.25); }
        else if (event.key === "0" || event.key === "Home") { event.preventDefault(); fit(); }
    });
    window.addEventListener("keyup", (event) => { if (event.code === "Space") space = false; });
    const assetUrl = (id) => {
        if (urls.has(id)) return urls.get(id);
        const asset = assets.get(id), encoded = document.getElementById(`canvas-file-${id}`).textContent.trim(), parts = [];
        for (let offset = 0; offset < encoded.length; offset += 65536) parts.push(Uint8Array.from(atob(encoded.slice(offset, offset + 65536)), (char) => char.charCodeAt(0)));
        const url = URL.createObjectURL(new Blob(parts, { type: asset.mime })); urls.set(id, url); return url;
    };
    const loadMedia = (media) => {
        media.addEventListener("error", () => { media.hidden = true; media.parentElement.querySelector(".media-error").hidden = false; }, { once: true });
        media.src = assetUrl(media.dataset.assetId);
    };
    const observer = new IntersectionObserver((entries) => { for (const entry of entries) if (entry.isIntersecting) { loadMedia(entry.target); observer.unobserve(entry.target); } }, { root: viewport });
    world.querySelectorAll("[data-asset-id]").forEach((media) => observer.observe(media));
    world.addEventListener("click", (event) => {
        const link = event.target.closest("[data-download-id]");
        if (!link) return;
        event.preventDefault();
        const download = document.createElement("a"); download.href = assetUrl(link.dataset.downloadId); download.download = link.download;
        document.body.append(download); download.click(); download.remove();
    });
    const preview = document.getElementById("image-preview");
    world.addEventListener("dblclick", (event) => {
        if (!event.target.matches("img[data-asset-id]")) return;
        preview.querySelector("img").src = assetUrl(event.target.dataset.assetId); preview.querySelector("img").alt = event.target.alt; preview.showModal();
    });
    document.getElementById("close-preview").onclick = () => preview.close();
    window.addEventListener("pagehide", () => { for (const url of urls.values()) URL.revokeObjectURL(url); });
    window.addEventListener("resize", fit);
    fit();
})();
