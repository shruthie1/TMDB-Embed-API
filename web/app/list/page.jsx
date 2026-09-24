'use client';
import { useEffect, useState } from 'react';
import { Card, CardSkeleton } from '../../components/Card';
import { EmptyState, Button } from '../../components/ui';
import { getList } from '../../lib/list';

export default function ListPage() {
  const [titles, setTitles] = useState(undefined);

  // Local-first: reads from localStorage, so it works with the VM down.
  useEffect(() => { setTitles(getList()); }, []);

  return (
    <div className="browse">
      <div className="browse-head"><h1 className="page-title">My list</h1></div>

      {titles === undefined ? (
        <div className="grid-titles" data-focus-group="">
          {Array.from({ length: 12 }, (_, i) => <CardSkeleton key={i} i={i} />)}
        </div>
      ) : titles.length === 0 ? (
        <EmptyState
          icon="bookmark"
          title="Nothing saved yet"
          hint="Add a film or series with + My List and it will appear here, on every device."
          action={<Button icon="filters" onClick={() => { window.location.href = '/browse'; }}>Browse titles</Button>}
        />
      ) : (
        <div className="grid-titles">
          {titles.map((t, i) => (
            <Card key={`${t.mediaType}-${t.tmdbId}`} title={t} i={i % 20} showType />
          ))}
        </div>
      )}
    </div>
  );
}
