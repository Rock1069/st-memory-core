const NS = 'http://www.w3.org/2000/svg';
function svgNode(tag, attributes) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}
const paths = {
  memory: ['M5 7.5 12 4l7 3.5v9L12 20l-7-3.5z', 'M5 7.5 12 11l7-3.5M12 11v9', 'M8.5 5.8 15.5 9'],
  book: ['M12 5c-3-2-7-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1z', 'M12 5v15M6 8h3M15 8h3M6 11h3M15 11h3'],
  archive: ['M3 4h18v4H3zM5 8v12h14V8M9 12h6'],
  checkpoint: ['M12 3v3M12 18v3M3 12h3M18 12h3', 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', 'M12 9v3l2 1'],
  download: ['M12 3v12M7 10l5 5 5-5M4 16v4h16v-4'],
  upload: ['M12 16V4M7 9l5-5 5 5M4 16v4h16v-4'],
  refresh: ['M20 7v5h-5M4 17v-5h5', 'M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2'],
  connection: ['m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0', 'm16 8 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0'],
  activity: ['M3 12h4l3-7 4 14 3-7h4'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
  lock: ['M6 10h12v10H6zM8 10V7a4 4 0 0 1 8 0v3M12 14v2'],
  close: ['m6 6 12 12M6 18 18 6'],
  arrow: ['M5 12h14m-5-5 5 5-5 5'],
  spark: ['m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z'],
  settings: ['M4 6h16M4 12h16M4 18h16', 'M8 3v6M16 9v6M10 15v6'],
};
export function icon(name, className = '') {
  const svg = svgNode('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: `memory-core-icon ${className}` });
  for (const d of paths[name] ?? paths.memory) svg.append(svgNode('path', { d }));
  return svg;
}
// Decorative memory constellation; it does not represent stored facts.
export function memoryMap() {
  const svg = svgNode('svg', { viewBox: '0 0 300 180', fill: 'none', 'aria-hidden': 'true', focusable: 'false', class: 'memory-core-map' });
  for (const [d, className] of [
    ['M28 128C87 3 232 15 279 94', 'memory-core-map-orbit'],
    ['M40 45C169 168 205 160 270 141', 'memory-core-map-orbit'],
    ['M76 41 153 94 237 43M153 94 254 130M153 94 55 137', 'memory-core-map-link'],
  ]) svg.append(svgNode('path', { d, class: className }));
  svg.append(svgNode('circle', { cx: 153, cy: 94, r: 41, class: 'memory-core-map-halo' }));
  svg.append(svgNode('circle', { cx: 153, cy: 94, r: 29, class: 'memory-core-map-center' }));
  for (const [cx, cy, r] of [[76, 41, 6], [237, 43, 5], [254, 130, 7], [55, 137, 4], [115, 68, 2], [204, 112, 2]]) svg.append(svgNode('circle', { cx, cy, r, class: 'memory-core-map-node' }));
  svg.append(svgNode('path', { d: 'm139 89 14-7 14 7v13l-14 7-14-7zM139 89l14 7 14-7M153 96v13', class: 'memory-core-map-symbol' }));
  return svg;
}
