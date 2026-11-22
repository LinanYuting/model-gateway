const fs = require('fs');
const html = fs.readFileSync('C:/Users/Zhong Yuting/Documents/deepseek-harness/default-workspace/gateway/public/index.html','utf8');
const i = html.indexOf('<script type="text/babel">');
const j = html.lastIndexOf('</script>');
const code = html.substring(i + 33, j);
console.log('Code length:', code.length);
console.log('Braces open:', (code.match(/\{/g)||[]).length, 'close:', (code.match(/\}/g)||[]).length);
console.log('Parens open:', (code.match(/\(/g)||[]).length, 'close:', (code.match(/\)/g)||[]).length);
console.log('Brackets open:', (code.match(/\[/g)||[]).length, 'close:', (code.match(/\]/g)||[]).length);
"