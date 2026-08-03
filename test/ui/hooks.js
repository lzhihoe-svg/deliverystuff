// Test hook: replace Drive thumbnail URLs with local placeholders so images render offline.
imgUrl = function (id, w) {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
    '<rect width="400" height="300" fill="#64748b"/>' +
    '<text x="200" y="150" font-size="28" fill="#fff" text-anchor="middle" font-family="sans-serif">' + id + '</text></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
};
