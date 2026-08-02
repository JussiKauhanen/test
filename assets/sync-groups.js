export const SYNC_GROUP_COUNT = 4;

export function buildPackageGroupEnds(packages) {
  const totalBytes = packages.reduce((sum, item) => sum + Math.max(1, item.byteLength), 0);
  const ends = [];
  let cursor = 0;
  let consumedBytes = 0;
  for (let group = 1; group < SYNC_GROUP_COUNT; group++) {
    const targetBytes = totalBytes * group / SYNC_GROUP_COUNT;
    while (cursor < packages.length && consumedBytes < targetBytes) {
      consumedBytes += Math.max(1, packages[cursor].byteLength);
      cursor++;
    }
    ends.push(cursor);
  }
  ends.push(packages.length);
  return ends;
}

export function groupForPackageIndex(index, groupEnds) {
  if (!Number.isInteger(index) || index < 0 || !Array.isArray(groupEnds)) return -1;
  return groupEnds.findIndex(end => index < end);
}

export function validGroupEnds(groupEnds, totalPackages) {
  return Array.isArray(groupEnds) && groupEnds.length === SYNC_GROUP_COUNT &&
    Number.isInteger(totalPackages) && totalPackages >= 0 &&
    groupEnds.at(-1) === totalPackages &&
    groupEnds.every((end, index) => Number.isInteger(end) && end >= 0 &&
      end <= totalPackages && (index === 0 || end >= groupEnds[index - 1]));
}

export function groupMaskForMissingIndexes(indexes, groupEnds) {
  let mask = 0;
  for (const index of indexes) {
    const group = groupForPackageIndex(index, groupEnds);
    if (group < 0) return (1 << SYNC_GROUP_COUNT) - 1;
    mask |= 1 << group;
  }
  return mask;
}

export function packagesForGroupMask(packages, groupEnds, groupMask) {
  return packages.filter((item, index) => {
    const group = groupForPackageIndex(index, groupEnds);
    return group >= 0 && (groupMask & 1 << group);
  });
}
