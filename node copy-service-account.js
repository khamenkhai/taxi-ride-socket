const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'src', 'serviceAccountKey.json');
const dest = path.join(__dirname, 'dist', 'serviceAccountKey.json');

fs.copyFileSync(src, dest);
console.log('✅ serviceAccountKey.json copied to dist/');
