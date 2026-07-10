var path = require('path');
var fs = require('fs');
var VUE_SRC = 'D:/project/admin-vue2/src';

var depData = JSON.parse(fs.readFileSync(path.join('D:/project/admin-vue2/autorefactor/ast/dep-graph.json'), 'utf-8'));
var graph = depData.graph || {};

function normPath(p) { return p.replace(/\\/g, '/'); }
var srcRoot = normPath(VUE_SRC);

// Find Tinymce's entry in the graph
Object.keys(graph).forEach(function(k) {
  var normK = normPath(k).replace(/ \+ \d+ modules$/, '');
  if (normK.includes('Tinymce/index.vue')) {
    console.log('Graph entry:', normK);
    console.log('Dependencies (' + (graph[k] || []).length + '):');
    (graph[k] || []).forEach(function(d) {
      console.log('  ' + normPath(d));
    });
  }
});

// Also check EditorImage
Object.keys(graph).forEach(function(k) {
  var normK = normPath(k).replace(/ \+ \d+ modules$/, '');
  if (normK.includes('EditorImage')) {
    console.log('');
    console.log('Graph entry:', normK);
    console.log('Dependencies (' + (graph[k] || []).length + '):');
    (graph[k] || []).forEach(function(d) {
      console.log('  ' + normPath(d));
    });
  }
});

// Also check what files Tinymce depends on that are NOT .vue (these become auxFiles)
console.log('');
console.log('=== Tinymce non-.vue dependencies ===');
Object.keys(graph).forEach(function(k) {
  var normK = normPath(k).replace(/ \+ \d+ modules$/, '');
  if (normK.includes('Tinymce/index.vue')) {
    (graph[k] || []).forEach(function(d) {
      var normD = normPath(d);
      if (!normD.endsWith('.vue')) {
        console.log('  ' + normD);
      }
    });
  }
});
