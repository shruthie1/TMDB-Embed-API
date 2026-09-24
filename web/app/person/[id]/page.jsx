'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Card, CardSkeleton } from '../../../components/Card';
import { Skeleton, EmptyState } from '../../../components/ui';
import { poster } from '../../../lib/api';

export default function PersonPage() {
  const { id } = useParams();
  const [data, setData] = useState(undefined);

  useEffect(() => {
    let alive = true;
    fetch(`/api/person/${id}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [id]);

  if (data === undefined) {
    return (
      <div className="browse">
        <div className="person-head">
          <Skeleton className="person-hero-ph" />
          <div style={{ flex: 1 }}>
            <Skeleton variant="text" width="42%" height="1.8em" />
            <Skeleton variant="text" width="22%" style={{ marginTop: 10 }} />
          </div>
        </div>
        <Skeleton variant="text" width={86} height="1.2em" style={{ margin: '0 0 14px' }} />
        <div className="grid-titles" data-focus-group="">
          {Array.from({ length: 12 }, (_, i) => <CardSkeleton key={i} i={i} />)}
        </div>
      </div>
    );
  }

  if (!data?.person) {
    return (
      <div className="browse">
        <EmptyState icon="search" title="Person not found"
                    hint="That profile is not in the catalog." />
      </div>
    );
  }

  const { person, titles } = data;
  const src = person.profile ? poster(person.profile, 'w185') : null;

  return (
    <div className="browse">
      <div className="person-head">
        <div className="person-hero-ph">
          {src ? <img src={src} alt="" width="96" height="96" />
               : <span className="person-initial">{person.name.slice(0, 1)}</span>}
        </div>
        <div>
          <h1 className="page-title">{person.name}</h1>
          {person.knownFor && <p className="person-known">{person.knownFor}</p>}
        </div>
      </div>

      {titles?.length ? (
        <>
          <h2 className="row-label" style={{ marginTop: 8 }}>Known for</h2>
          <div className="grid-titles">
            {titles.map((t, i) => (
              <Card key={`${t.mediaType}-${t.tmdbId}`} title={t} i={i % 20} showType />
            ))}
          </div>
        </>
      ) : (
        <EmptyState icon="search" title="No titles to show"
                    hint="Nothing in the catalog lists this person in a leading role." />
      )}
    </div>
  );
}
