export const progressToPercentage = (current: number, target: number): number => {
  if (target <= 0) {
    return 100
  }
  return Math.max(0, Math.min(100, (current / target) * 100))
}
