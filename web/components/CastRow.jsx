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

export function CastRowSkeleton({ count = 6 }) {
  return (
    <div className="cast-rail" data-rail="" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="person" key={i}>
          <Skeleton className="person-ph" />
          <Skeleton variant="text" width="80%" style={{ margin: '8px auto 0' }} />
          <Skeleton variant="text" width="56%" style={{ margin: '5px auto 0', height: '.62em' }} />
        </div>
      ))}
    </div>
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
