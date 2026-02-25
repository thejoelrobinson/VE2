// Shared media utilities

// Generate a stable hash key for a media item (used for caching thumbnails, waveforms, etc.)
export function generateMediaHash(mediaItem) {
  const name = (mediaItem.file?.name || mediaItem.name || 'unknown');
  return name.replace(/[^a-z0-9]/gi, '_') + '_' + (mediaItem.file?.size || mediaItem.size || 0);
}
