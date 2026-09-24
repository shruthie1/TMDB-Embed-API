import { describe, it, expect, afterEach } from 'vitest';
import { HLS_CONFIG, HLS_CONFIG_TV, HLS_CONFIG_HYBRID, configFor, isTvDevice, tvLevelCap,
         networkLevelCap, TV_MAX_HEIGHT, defaultLevelCap,
         DEFAULT_MAX_HEIGHT } from '../lib/player/hlsConfig';

const setUA = (ua, deviceMemory) => {
  // navigator is getter-only in the node pool, so it has to be redefined
  // rather than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, ...(deviceMemory ? { deviceMemory } : {}) },
    configurable: true, writable: true,
  });
};
afterEach(() => {
  Object.defineProperty(globalThis, 'navigator',
    { value: undefined, configurable: true, writable: true });
});

describe('isTvDevice', () => {
  it('recognises the platforms this household actually watches on', () => {
    for (const ua of [
      'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36',
      'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36',
      'Mozilla/5.0 (Linux; Android 9; AFTKA Build/PS7285) Silk/104',
      'Mozilla/5.0 (Linux; Android 10; Android TV) AppleWebKit/537.36',
      'Mozilla/5.0 (CrKey armv7l 1.5.16041) AppleWebKit/537.36',
    ]) { setUA(ua); expect(isTvDevice(), ua).toBe(true); }
  });

  it('does not mistake a phone or laptop for a TV', () => {
    for (const ua of [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120',
    ]) { setUA(ua); expect(isTvDevice(), ua).toBe(false); }
  });

  it('treats a 2GB device as constrained whatever it calls itself', () => {
    setUA('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36', 2);
    expect(isTvDevice()).toBe(true);
    setUA('Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36', 8);
    expect(isTvDevice()).toBe(false);
  });

  it('is false, not a crash, when there is no navigator at all', () => {
    expect(isTvDevice()).toBe(false);   // server render
  });
});

describe('the TV buffer profile', () => {
  // Measured on the live streams: ~10.8MB carries ~6s at ~14 Mbps. Both memory
  // rules below are derived from it rather than from a remembered number.
  const MB_PER_SECOND_4K = 10.8 / 6;
  const secondsHeldBy = (bytes) => bytes / 1e6 / MB_PER_SECOND_4K;

  it('gives each profile enough memory to reach its own length ceiling', () => {
    // The RULE, not a snapshot. A byte cap below what the length ceiling can
    // hold makes that ceiling unreachable - which is exactly what was silently
    // true on the TV profile: 60MB held ~33s against a 60s ceiling, so ABR
    // could never reach it however good the line was.
    //
    // Asserting the derivation rather than the literal is deliberate. Pinning
    // `toBe(600MB)` failed a raise that was safe, catching nothing real; this
    // fails only when a cap genuinely cannot back its ceiling.
    for (const [name, cfg] of [['laptop', HLS_CONFIG], ['tv', HLS_CONFIG_TV]]) {
      expect(secondsHeldBy(cfg.maxBufferSize), name)
        .toBeGreaterThanOrEqual(cfg.maxMaxBufferLength);
    }
  });

  it('asks for far less memory on a TV, in absolute terms and relative', () => {
    // Relative alone is not enough: raising BOTH profiles together would keep
    // the ratio while handing a 2GB device a buffer it cannot hold. The
    // absolute ceiling is what actually protects that device - this profile
    // covers anything reporting <=2GB (see isTvDevice).
    expect(HLS_CONFIG_TV.maxBufferSize).toBeLessThanOrEqual(250 * 1000 * 1000);
    expect(HLS_CONFIG_TV.maxBufferSize).toBeLessThanOrEqual(HLS_CONFIG.maxBufferSize / 3);
    expect(HLS_CONFIG_TV.maxMaxBufferLength).toBeLessThan(HLS_CONFIG.maxMaxBufferLength);
    expect(HLS_CONFIG_TV.backBufferLength).toBeLessThan(HLS_CONFIG.backBufferLength);
  });

  it('inherits everything that is not about memory', () => {
    // The CDN timeouts and the Origin-avoiding xhrSetup are as true on a TV.
    expect(HLS_CONFIG_TV.fragLoadingTimeOut).toBe(HLS_CONFIG.fragLoadingTimeOut);
    expect(HLS_CONFIG_TV.xhrSetup).toBe(HLS_CONFIG.xhrSetup);
    // Still not capLevelToPlayerSize: a pre-layout element reports 0 and
    // hls.js then loads no level at all.
    expect(HLS_CONFIG_TV.capLevelToPlayerSize).toBe(false);
  });

  it('picks the profile from the device', () => {
    expect(configFor({ tv: true })).toBe(HLS_CONFIG_TV);
    expect(configFor({ tv: false })).toBe(HLS_CONFIG);
  });

  // A hybrid binds one provider's video to another's audio renditions. The two
  // sides are the same CUT - measured on Devara (811941), showsst 10299.6s vs
  // castle 10299.6s, drift 0.0s - but they are NOT segmented alike: video runs
  // uniform 5.000s fragments while 39% of the audio fragments are under 2s, and
  // the boundaries drift up to 1.96s apart mid-film. On a seek hls.js looks for
  // the audio fragment covering the target timestamp, and the stock
  // maxBufferHole of 0.5s treats that 1.96s straddle as an unrecoverable hole.
  it('a hybrid gets gap tolerances wider than the measured 1.96s boundary drift', () => {
    const c = configFor({ tv: false, hybrid: true });
    expect(c).toBe(HLS_CONFIG_HYBRID);
    expect(c.maxBufferHole).toBeGreaterThan(1.96);
    expect(c.maxFragLookUpTolerance).toBeGreaterThan(1.96);
    // The defaults this exists to override.
    expect(HLS_CONFIG.maxBufferHole).toBeLessThan(1.96);
  });

  it('a hybrid on a TV keeps the TV memory caps', () => {
    const c = configFor({ tv: true, hybrid: true });
    expect(c.maxBufferHole).toBe(HLS_CONFIG_HYBRID.maxBufferHole);
    expect(c.maxFragLookUpTolerance).toBe(HLS_CONFIG_HYBRID.maxFragLookUpTolerance);
    // A TV has far less memory than a desktop, so the hybrid's roomier buffer
    // must not override the caps that keep it from being killed.
    expect(c.maxBufferSize).toBe(HLS_CONFIG_TV.maxBufferSize);
    expect(c.maxMaxBufferLength).toBe(HLS_CONFIG_TV.maxMaxBufferLength);
  });

  it('a non-hybrid is untouched by the hybrid profile', () => {
    expect(configFor({ tv: false, hybrid: false })).toBe(HLS_CONFIG);
    expect(configFor({ tv: true, hybrid: false })).toBe(HLS_CONFIG_TV);
  });
});

describe('tvLevelCap', () => {
  const ladder = [
    { height: 2160 }, { height: 1080 }, { height: 720 }, { height: 480 },
  ];

  it('caps at the best rung a TV box can decode, not the best available', () => {
    // 4K on this catalogue is ~16 Mbps; a box that cannot decode it drops
    // frames and rebuffers, which reads as a network fault.
    expect(tvLevelCap(ladder)).toBe(1);
    expect(ladder[tvLevelCap(ladder)].height).toBe(TV_MAX_HEIGHT);
  });

  it('takes the smallest rung when every rung is above the cap', () => {
    // A 4K-only ladder must still play rather than refuse.
    const only4k = [{ height: 2160 }, { height: 4320 }];
    expect(tvLevelCap(only4k)).toBe(0);
  });

  it('does not cap when the ladder is unknown or unlabelled', () => {
    expect(tvLevelCap([])).toBe(-1);
    expect(tvLevelCap([{ height: 0 }, { height: undefined }])).toBe(-1);
  });
});

describe('defaultLevelCap', () => {
  const ladder = [
    { height: 2160 }, { height: 1080 }, { height: 720 }, { height: 480 },
  ];

  it('keeps ABR off the 4K rung on an ordinary screen', () => {
    // A 4K segment on this catalogue measured 6.2MB against 1.0MB for the
    // same four seconds at a sane rung. Nobody in the household watches on a
    // 4K panel, so the extra bytes buy no visible picture - they only move
    // through the relay and on to the Vercel bill.
    expect(defaultLevelCap(ladder)).toBe(1);
    expect(ladder[defaultLevelCap(ladder)].height).toBe(DEFAULT_MAX_HEIGHT);
  });

  it('still plays a ladder that offers nothing below 4K', () => {
    expect(defaultLevelCap([{ height: 2160 }, { height: 4320 }])).toBe(0);
  });

  it('leaves ABR alone when the ladder is unknown or unlabelled', () => {
    // Capping to index 0 on an unlabelled ladder would pin the viewer to
    // whatever happened to be listed first.
    expect(defaultLevelCap([])).toBe(-1);
    expect(defaultLevelCap([{ height: 0 }, { height: undefined }])).toBe(-1);
  });

  it('does not cap a ladder that never reaches 4K', () => {
    // Every rung is already allowed, so the best one is the cap and ABR is
    // unconstrained in practice.
    const sd = [{ height: 1080 }, { height: 720 }];
    expect(defaultLevelCap(sd)).toBe(0);
  });
});

describe('network-aware ABR cap', () => {
  const ladder = [{ height: 2160 }, { height: 1080 }, { height: 720 }, { height: 480 }, { height: 360 }];

  it('caps data-saver and slow connections to a playable lower rung', () => {
    expect(ladder[networkLevelCap(ladder, { saveData: true })].height).toBe(360);
    expect(ladder[networkLevelCap(ladder, { effectiveType: '2g' })].height).toBe(480);
    expect(ladder[networkLevelCap(ladder, { effectiveType: '3g' })].height).toBe(720);
  });

  it('uses downlink when effectiveType is unavailable', () => {
    expect(ladder[networkLevelCap(ladder, { downlink: 1.2 })].height).toBe(720);
    expect(ladder[networkLevelCap(ladder, { downlink: 3.5 })].height).toBe(1080);
    expect(networkLevelCap(ladder, { downlink: 10 })).toBe(-1);
  });

  it('does not cap when the browser exposes no connection data', () => {
    expect(networkLevelCap(ladder, null)).toBe(-1);
    expect(networkLevelCap([], { effectiveType: '2g' })).toBe(-1);
  });
});

describe('ABR tuning for large segments', () => {
  // These are the values a viewer feels as "it buffers instead of dropping
  // quality". hls.js defaults assume short segments; this catalogue's are
  // 3-8MB and take 6-10s.
  it('reacts to a bandwidth dip in seconds, not in fragments', () => {
    // Default abrEwmaFastVoD is 3 FRAGMENTS ~ 18s of history here.
    expect(HLS_CONFIG.abrEwmaFastVoD).toBeLessThanOrEqual(2);
    expect(HLS_CONFIG.abrEwmaSlowVoD).toBeGreaterThan(HLS_CONFIG.abrEwmaFastVoD);
  });

  it('drops sooner than it climbs', () => {
    // Asymmetric on purpose: dropping early costs sharpness, climbing early
    // costs a stall, and a stall is worse.
    expect(HLS_CONFIG.abrBandWidthUpFactor)
      .toBeLessThan(HLS_CONFIG.abrBandWidthFactor);
    expect(HLS_CONFIG_TV.abrBandWidthUpFactor)
      .toBeLessThan(HLS_CONFIG_TV.abrBandWidthFactor);
  });

  it('is more defensive on a TV, which has less buffer to fall back on', () => {
    expect(HLS_CONFIG_TV.abrEwmaFastVoD).toBeLessThanOrEqual(HLS_CONFIG.abrEwmaFastVoD);
    expect(HLS_CONFIG_TV.abrBandWidthFactor).toBeLessThan(HLS_CONFIG.abrBandWidthFactor);
  });

  it('never sets a starvation threshold below one segment duration', () => {
    // Segments take 6-10s. A threshold under that fires constantly and causes
    // the rung thrash it is meant to prevent.
    for (const cfg of [HLS_CONFIG, HLS_CONFIG_TV]) {
      expect(cfg.maxStarvationDelay).toBeGreaterThanOrEqual(6);
      expect(cfg.maxLoadingDelay).toBeGreaterThanOrEqual(6);
    }
  });

  it('starts from a realistic estimate rather than 500kbps', () => {
    expect(HLS_CONFIG.abrEwmaDefaultEstimate).toBeGreaterThan(1_000_000);
  });
});

describe('the buffer / down-switch relationship', () => {
  it('keeps the buffer short enough that hls.js can still abandon a fragment', () => {
    // hls.js only abandons an in-flight fragment when finishing it would
    // outlast the buffer:
    //     if (fragLoadedDelay <= bufferStarvationDelay) return;
    // bufferStarvationDelay IS the buffer length, so a large buffer disables
    // the 100ms emergency down-switch entirely. At 120s a fragment had to take
    // over two minutes to trigger a drop - the reported "buffers instead of
    // dropping quality". Segments are 6-10s, so the buffer must stay within a
    // few segments for the rule to fire.
    for (const cfg of [HLS_CONFIG, HLS_CONFIG_TV]) {
      expect(cfg.maxBufferLength).toBeLessThanOrEqual(40);
      expect(cfg.maxMaxBufferLength).toBeLessThanOrEqual(90);
    }
  });

  it('drops on time in the 3-4 Mbps band, where an unstable line sits', () => {
    // The buffer IS the down-switch deadline: hls.js abandons an in-flight
    // fragment only when finishing it would outlast the buffer. Modelled on the
    // measured segment size (~10.8MB per 6s at ~14 Mbps), a fragment takes
    // 10.8*8/mbps seconds to pull, and the drop fires only if that exceeds the
    // buffer. At 30s a dip to 4 Mbps fired 8s late - the residue of the same
    // fault 120s caused outright.
    const fragSeconds = (mbps) => (10.8 * 8) / mbps;
    for (const mbps of [3, 4]) {
      expect(fragSeconds(mbps), `${mbps} Mbps must trigger a drop`)
        .toBeGreaterThan(HLS_CONFIG.maxBufferLength);
    }
  });

  it('leaves climbing alone, so a shorter buffer cannot cause rung flapping', () => {
    // The up-switch is gated by the bandwidth ESTIMATE against
    // abrBandWidthUpFactor; the buffer is not part of that test. Shortening the
    // buffer must not be accompanied by a friendlier up-factor, or ABR climbs
    // on a marginal estimate and immediately drops back.
    expect(HLS_CONFIG.abrBandWidthUpFactor).toBeLessThan(HLS_CONFIG.abrBandWidthFactor);
    expect(HLS_CONFIG_TV.abrBandWidthUpFactor).toBeLessThan(HLS_CONFIG_TV.abrBandWidthFactor);
  });

  it('still holds several segments, so an ordinary dip does not stall', () => {
    // The opposite failure: too small and hls.js goes idle then restarts,
    // abandoning in-flight fragments (measured as (canceled) network rows).
    expect(HLS_CONFIG.maxBufferLength).toBeGreaterThanOrEqual(20);
  });
});
