// Minimální funkční náhrada Leaflet API použitého v aplikaci — pro smoke test
// bez závislosti na reálné CDN knihovně (síťová politika sandboxu blokuje
// unpkg.com/jsdelivr.net). Nekreslí mapu, jen nesmí shodit appku a musí
// zachovat volací kontrakt (addTo/on/setUrl/setOpacity/...).
(function (global) {
  function makeLayer(extra) {
    extra = extra || {};
    const layer = Object.assign({
      _map: null,
      _handlers: {},
      addTo(target) {
        this._map = target;
        target._layers = target._layers || [];
        target._layers.push(this);
        return this;
      },
      remove() {
        if (this._map && this._map._layers) {
          const i = this._map._layers.indexOf(this);
          if (i >= 0) this._map._layers.splice(i, 1);
        }
        return this;
      },
      removeLayer(l) { l.remove(); return this; },
      bindPopup(html) { this._popupHtml = html; return this; },
      openPopup() {
        this._handlers.popupopen?.forEach(cb => cb({ target: this }));
        return this;
      },
      on(evt, cb) { (this._handlers[evt] = this._handlers[evt] || []).push(cb); return this; },
      fire(evt, data) { (this._handlers[evt] || []).forEach(cb => cb(data)); return this; },
      setOpacity(o) { this._opacity = o; return this; },
      setUrl(u) { this._url = u; this.fire("load"); return this; },
      getElement() {
        if (!this._el) {
          this._el = document.createElement("img");
          Object.defineProperty(this._el, "complete", { value: true });
        }
        return this._el;
      },
      clearLayers() { this._layers = []; return this; },
    }, extra);
    return layer;
  }

  const L = {
    map(idOrEl) {
      const el = typeof idOrEl === "string" ? document.getElementById(idOrEl) : idOrEl;
      const map = makeLayer({ el, _zoom: 7 });
      map.setView = function (latlng, zoom) { this._center = latlng; this._zoom = zoom; return this; };
      map.getZoom = function () { return this._zoom; };
      // Výřez odvozený od středu — worldtemp.js podle něj vybírá dlaždice.
      // Bez getBounds by teplotní vrstva v testu tiše nic nevykreslila.
      map.getBounds = function () {
        const c = this._center || { lat: 50.0, lng: 14.4 };
        const lat = Array.isArray(c) ? c[0] : (c.lat ?? 50.0);
        const lon = Array.isArray(c) ? c[1] : (c.lng ?? 14.4);
        const d = 180 / Math.pow(2, this._zoom || 7);
        return {
          getSouth: () => lat - d, getNorth: () => lat + d,
          getWest: () => lon - d * 2, getEast: () => lon + d * 2,
        };
      };
      if (el) {
        el.addEventListener("click", ev => {
          // Simulace: střed testovací lokace (odpovídá URL ?lat=50.09&lon=14.40 ve smoke testu)
          map.fire("click", { latlng: { lat: 50.09, lng: 14.40 } });
        });
      }
      return map;
    },
    control: { zoom() { return { addTo() { return this; } }; } },
    tileLayer() { return makeLayer(); },
    imageOverlay(url) { return makeLayer({ _url: url }); },
    marker(latlng) { return makeLayer({ _latlng: latlng }); },
    circleMarker(latlng, opts) { return makeLayer({ _latlng: latlng, options: opts }); },
    divIcon(opts) { return { options: opts }; },
    polygon(latlngs) { return makeLayer({ _latlngs: latlngs }); },
    polyline(latlngs) { return makeLayer({ _latlngs: latlngs }); },
    layerGroup() {
      const g = makeLayer({ _sub: [] });
      g.addLayer = function (l) { this._sub.push(l); return this; };
      return g;
    },
  };
  global.L = L;
})(window);
