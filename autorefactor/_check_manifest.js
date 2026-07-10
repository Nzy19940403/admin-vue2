var path = require('path');
var fs = require('fs');
var VUE_SRC = 'D:/project/admin-vue2/src';

var depData = JSON.parse(fs.readFileSync(path.join(__dirname, 'ast/dep-graph.json'), 'utf-8'));
var graph = depData.graph || {};

function normPath(p) { return p.replace(/\\/g, '/'); }

var seen = {};
var manifest = [];
Object.keys(graph).forEach(function(absFile) {
  var cleanFile = absFile.replace(/ \+ \d+ modules$/, '');
  if (!cleanFile.endsWith('.vue')) return;
  absFile = cleanFile;
  var norm = normPath(absFile);
  var rel  = norm.replace(normPath(VUE_SRC) + '/', '');

  var out;
  if (rel.startsWith('views/')) {
    out = rel;
  } else if (rel.startsWith('layout/') || rel.startsWith('components/')) {
    out = rel.startsWith('components/')
      ? 'components/admin/' + rel.replace(/^components\//, '')
      : 'components/admin/' + rel;
  } else { return; }

  if (seen[out]) return;
  seen[out] = true;
  var key = out.replace(/[\/\\]/g, '_').replace('.vue', '');
  manifest.push({ key: key, file: rel, out: out });
});

// Show subdirectory components
console.log('=== Subdirectory components ===');
['Share', 'Charts', 'Upload', 'TextHoverEffect', 'Tinymce'].forEach(function(dir) {
  var hits = manifest.filter(function(m) { return m.file.includes(dir + '/') });
  hits.forEach(function(h) {
    console.log('  key=' + h.key + ' | out=src/' + h.out);
  });
});

console.log('');
// Check for path flattening issues:
// The 'key' should preserve directory structure
var keys = manifest.map(function(m) { return m.key; });
var outs = manifest.map(function(m) { return m.out; });

console.log('Total manifest entries: ' + manifest.length);
console.log('Unique keys: ' + new Set(keys).size);
console.log('Unique outs: ' + new Set(outs).size);

// Check if any keys have been flattened (lost directory info)
manifest.forEach(function(m) {
  var dirs = m.file.split('/');
  var outDirs = m.out.split('/');
  if (dirs.length !== outDirs.length) {
    // Wait, out always has 'components/admin/' prefix instead of 'components/'
    // So out should have 1 more segment
    var expectedSegs = dirs.length + 1; // +1 for 'admin'
    if (outDirs.length !== expectedSegs) {
      console.log('MISMATCH: file=' + m.file + ' (' + dirs.length + ' segs) -> out=' + m.out + ' (' + outDirs.length + ' segs)');
    }
  }
});
