import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import VideoMenu from '../../components/player/VideoMenu';
afterEach(cleanup);
describe('compact provider stream list', () => {
  it('lists every catalog stream directly under NetMirror and makes the whole row selectable', () => {
    const pick=vi.fn();
    const choices=['Netflix','Prime Video','Hotstar'].map((catalog,i)=>({id:`nm${i}`,label:'NetMirror',quality:'720p',source:{id:`nm${i}`,provider:'NetMirror',netmirrorCatalog:catalog,languages:['Telugu']}}));
    const view=render(<VideoMenu open choices={choices} currentId="nm0" onPick={pick}/>);
    fireEvent.click(view.getByRole('menuitemradio',{name:/NetMirror/}));
    expect(view.getAllByRole('menuitemradio')).toHaveLength(3);
    expect(document.activeElement.getAttribute('role')).toBe('menuitemradio');
    fireEvent.click(view.getByText(/Prime Video/));
    expect(pick).toHaveBeenCalledWith(choices[1]);
    fireEvent.keyDown(view.getByRole('menu',{name:'NetMirror'}),{key:'Escape'});
    expect(view.getByRole('menu',{name:'Server'})).toBeTruthy();
    expect(document.activeElement.textContent).toContain('NetMirror');
  });
  it('checks an empty provider on demand and keeps its retry action clickable',()=>{
    const check=vi.fn();
    const view=render(<VideoMenu open choices={[{id:'ct',label:'CastleTV',source:{provider:'CastleTV'}}]} onCheckSources={check}/>);
    fireEvent.click(view.getByRole('menuitemradio',{name:/NetMirror/}));
    expect(check).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('menuitem',{name:'Check for more streams'}));
    expect(check).toHaveBeenCalledTimes(2);
  });
});
