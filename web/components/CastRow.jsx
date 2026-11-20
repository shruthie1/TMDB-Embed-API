'use client';
import Link from 'next/link';
import { poster } from '../lib/api';
import { Skeleton } from './ui';

/** A cast member links to their filmography - otherwise the row is a dead end. */
function PersonCard({ person }) {
  const src = person.profile ? poster(person.profile, 'w185') : null;
  return (
    <Link href={`/person/${person.id}`} className="person focusable" data-focus=""
          role="listitem" aria-label={`${person.name}${person.character ? `, as ${person.character}` : ''}`}>
      <div className="person-ph">
        {src
          ? <img src={src} alt="" loading="lazy" decoding="async" width="74" height="74" />
          : <span className="person-initial">{person.name.slice(0, 1)}</span>}
      </div>
      <b>{person.name}</b>
      {person.character && <span>{person.character}</span>}
    </Link>
  );
}

export function CastRowSkeleton({ count = 10 }) {
  // Same section and label as CastRow, so the rows below do not move when the
  // cast lands. Enough people to fill a TV-wide rail; the rail clips the rest.
  return (
    <section className="row-sec" aria-hidden="true">
      <div className="row-head"><h2 className="row-label">Cast</h2></div>
      <div className="cast-rail" data-rail="">
        {Array.from({ length: count }, (_, i) => (
          <div className="person" key={i}>
            <Skeleton className="person-ph" />
            {/* Bars inside the real <b>/<span>, so they take the name and
                character line boxes. Two lines each: most names and roles
                wrap once on a TV-width person. */}
            <b><i className="skel skel-line" style={{ width: '86%' }} /><i className="skel skel-line" style={{ width: '60%' }} /></b>
            <span><i className="skel skel-line" style={{ width: '70%' }} /><i className="skel skel-line" style={{ width: '44%' }} /></span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function CastRow({ credits }) {
  if (!credits?.length) return null;
  return (
    <section className="row-sec">
      <div className="row-head"><h2 className="row-label">Cast</h2></div>
      <div className="cast-rail" role="list">
        {credits.map(p => <PersonCard key={p.id} person={p} />)}
      </div>
    </section>
  );
}
