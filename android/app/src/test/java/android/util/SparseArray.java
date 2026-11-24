package android.util;

import java.util.TreeMap;

/**
 * JVM test stand-in for android.util.SparseArray (the android.jar stub returns
 * defaults under unitTests.isReturnDefaultValues). Only media3's TsExtractor
 * uses it in tests (InStreamAudioTest). Test classes load before android.jar.
 */
public class SparseArray<E> implements Cloneable {
    private TreeMap<Integer, E> map = new TreeMap<>();
    public SparseArray() {}
    public SparseArray(int initialCapacity) {}
    public E get(int key) { return map.get(key); }
    public E get(int key, E valueIfKeyNotFound) { E v = map.get(key); return v == null ? valueIfKeyNotFound : v; }
    public void put(int key, E value) { map.put(key, value); }
    public void append(int key, E value) { map.put(key, value); }
    public void remove(int key) { map.remove(key); }
    public void delete(int key) { map.remove(key); }
    public void removeAt(int index) { map.remove(keyAt(index)); }
    public int size() { return map.size(); }
    public void clear() { map.clear(); }
    public boolean contains(int key) { return map.containsKey(key); }
    public int keyAt(int index) { return (Integer) map.keySet().toArray()[index]; }
    @SuppressWarnings("unchecked")
    public E valueAt(int index) { return (E) map.values().toArray()[index]; }
    public int indexOfKey(int key) { return map.containsKey(key) ? map.headMap(key).size() : -1; }
    @SuppressWarnings("unchecked")
    @Override public SparseArray<E> clone() { SparseArray<E> c = new SparseArray<>(); c.map = new TreeMap<>(map); return c; }
}
