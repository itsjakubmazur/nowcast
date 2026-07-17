// Minimální náhrada leaflet-velocity pro smoke test — reálná knihovna vyžaduje
// plný Leaflet (L.Layer/L.DomUtil/L.Control...), který leaflet-stub.js
// neposkytuje. Appka jen potřebuje objekt s addTo()/remove(), víc ne.
(function (global) {
  global.L.velocityLayer = function (opts) {
    return {
      options: opts,
      _map: null,
      addTo(m) {
        this._map = m;
        m._layers = m._layers || [];
        m._layers.push(this);
        return this;
      },
      remove() {
        if (this._map && this._map._layers) {
          const i = this._map._layers.indexOf(this);
          if (i >= 0) this._map._layers.splice(i, 1);
        }
        return this;
      },
      setOpacity() { return this; },
    };
  };
})(window);
