#!/usr/bin/env node
'use strict';
// Stand-in for ffprobe, selected via FFPROBE_PATH. Lets the probe's parsing,
// caching and failure handling be tested without a network or a real file.
//
// Behaviour is driven by the url argument (always the last arg):
//   ...#fail      -> exit non-zero, as ffprobe does on an unreachable url
//   ...#noaudio   -> a video-only file
//   ...#multi     -> Telugu + Hindi + an untagged track
//   ...#und       -> one aac track tagged `und` (the muxer default)
//   anything else -> one eng aac track
// Every invocation appends its argv to $FAKE_FFPROBE_LOG so a test can assert
// how many probes actually ran, and what headers were passed.
const fs = require('fs');
const args = process.argv.slice(2);
const url = args[args.length - 1] || '';

if (process.env.FAKE_FFPROBE_LOG) {
    fs.appendFileSync(process.env.FAKE_FFPROBE_LOG, JSON.stringify(args) + '\n');
}

if (url.includes('#fail')) {
    process.stderr.write('fake-ffprobe: simulated failure\n');
    process.exit(1);
}

const streams = url.includes('#und')
    ? [
        { codec_type: 'video', codec_name: 'h264', tags: { language: 'und' } },
        { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'und' } },
    ]
    : url.includes('#noaudio')
    ? [{ codec_type: 'video', codec_name: 'h264' }]
    : url.includes('#multi')
        ? [
            { codec_type: 'video', codec_name: 'h264', tags: { language: 'eng' } },
            { codec_type: 'audio', codec_name: 'aac', channels: 6, tags: { language: 'tel' } },
            { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'hin' } },
            { codec_type: 'audio', codec_name: 'ac3', channels: 2 },
        ]
        : [
            { codec_type: 'video', codec_name: 'h264' },
            { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' } },
        ];

process.stdout.write(JSON.stringify({ streams }));
