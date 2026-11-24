package android.util;

import java.util.TreeMap;

/** JVM test stand-in, see SparseArray. */
public class SparseIntArray implements Cloneable {
    private TreeMap<Integer, Integer> map = new TreeMap<>();
    public SparseIntArray() {}
    public SparseIntArray(int initialCapacity) {}
    public int get(int key) { return get(key, 0); }
    public int get(int key, int valueIfKeyNotFound) { Integer v = map.get(key); return v == null ? valueIfKeyNotFound : v; }
    public void put(int key, int value) { map.put(key, value); }
    public void append(int key, int value) { map.put(key, value); }
    public void delete(int key) { map.remove(key); }
    public void removeAt(int index) { map.remove(keyAt(index)); }
    public int size() { return map.size(); }
    public void clear() { map.clear(); }
    public int keyAt(int index) { return (Integer) map.keySet().toArray()[index]; }
    public int valueAt(int index) { return (Integer) map.values().toArray()[index]; }
    public int indexOfKey(int key) { return map.containsKey(key) ? map.headMap(key).size() : -1; }
    @Override public SparseIntArray clone() { SparseIntArray c = new SparseIntArray(); c.map = new TreeMap<>(map); return c; }
}
