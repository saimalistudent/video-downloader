'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const source = path.join(
  root,
  '..',
  '.cursor',
  'projects',
  'c-Users-ARSAM-solardash',
  'assets',
  'c__Users_ARSAM_AppData_Roaming_Cursor_User_workspaceStorage_empty-window_images_ChatGPT_Image_Jun_12__2026__11_15_08_AM-84ee24d5-5069-4d41-ae7a-d78213238877.png'
);

const fallback = path.join(root, 'icon-source.png');

async function main() {
  const input = fs.existsSync(source) ? source : fallback;
  if (!fs.existsSync(input)) {
    throw new Error('Icon source not found');
  }

  await sharp(input).resize(512, 512).png().toFile(path.join(root, 'icon-512.png'));
  await sharp(input).resize(192, 192).png().toFile(path.join(root, 'icon-192.png'));
  await sharp(input).resize(180, 180).png().toFile(path.join(root, 'apple-touch-icon.png'));
  console.log('Icons ready: icon-512.png, icon-192.png, apple-touch-icon.png');
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
