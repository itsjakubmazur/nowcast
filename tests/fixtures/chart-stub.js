// Minimální náhrada Chart.js — appka jen potřebuje "new Chart(canvas, cfg)"
// a ".destroy()" bez pádu; reálné vykreslení grafu není pro smoke test potřeba.
(function (global) {
  class Chart {
    constructor(ctx, config) {
      this.ctx = ctx;
      this.config = config;
      Chart.instances.push(this);
    }
    destroy() {
      const i = Chart.instances.indexOf(this);
      if (i >= 0) Chart.instances.splice(i, 1);
    }
    update() {}
  }
  Chart.instances = [];
  global.Chart = Chart;
})(window);
