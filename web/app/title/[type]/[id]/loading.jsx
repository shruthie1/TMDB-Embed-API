import TitleSkeleton from '../../../../components/TitleSkeleton';

/**
 * Shown the instant a card is pressed.
 *
 * This route is dynamic, so a client navigation waits for a server round trip
 * (the RSC payload) before Next swaps pages. With no loading boundary the old
 * page stayed on screen for that whole wait with no sign the press landed:
 * measured 0.4-0.5s on a good link, and every extra second of a cold function
 * or a slow TV network read as a dead click. A loading boundary lets Next
 * prefetch up to here and render this skeleton immediately on press.
 */
export default function Loading() {
  return <TitleSkeleton />;
}
