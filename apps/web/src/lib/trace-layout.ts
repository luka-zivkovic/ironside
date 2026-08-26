export const DEFAULT_TREE_SHARE = 42;
export const PAYLOAD_TREE_SHARE = 34;
export const MIN_TREE_SHARE = 25;
export const MAX_TREE_SHARE = 65;

export const SPLITTER_WIDTH_PX = 12;
const MIN_TREE_WIDTH_PX = 280;
const MIN_INSPECTOR_WIDTH_PX = 360;

export function preferredTreeShare(hasPayload: boolean): number {
  return hasPayload ? PAYLOAD_TREE_SHARE : DEFAULT_TREE_SHARE;
}

export function clampTreeShare(desiredShare: number, containerWidth: number): number {
  const width = Math.max(1, containerWidth);
  const widthConstrainedMin = (MIN_TREE_WIDTH_PX / width) * 100;
  const widthConstrainedMax = ((width - SPLITTER_WIDTH_PX - MIN_INSPECTOR_WIDTH_PX) / width) * 100;
  const minimum = Math.min(50, Math.max(MIN_TREE_SHARE, widthConstrainedMin));
  const maximum = Math.max(minimum, Math.min(MAX_TREE_SHARE, widthConstrainedMax));

  return Math.min(maximum, Math.max(minimum, desiredShare));
}

export function treeShareFromPointer(clientX: number, containerLeft: number, containerWidth: number): number {
  const width = Math.max(1, containerWidth);
  const desiredTreeWidth = clientX - containerLeft - SPLITTER_WIDTH_PX / 2;
  const desiredShare = (desiredTreeWidth / width) * 100;
  return clampTreeShare(desiredShare, containerWidth);
}
