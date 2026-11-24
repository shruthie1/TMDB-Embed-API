package android.util;

import java.util.TreeMap;

/** JVM test stand-in, see SparseArray. */
public class SparseBooleanArray implements Cloneable {
    private TreeMap<Integer, Boolean> map = new TreeMap<>();
    public SparseBooleanArray() {}
    public SparseBooleanArray(int initialCapacity) {}
    public boolean get(int key) { return get(key, false); }
    public boolean get(int key, boolean valueIfKeyNotFound) { Boolean v = map.get(key); return v == null ? valueIfKeyNotFound : v; }
    public void put(int key, boolean value) { map.put(key, value); }
    public void append(int key, boolean value) { map.put(key, value); }
    public void delete(int key) { map.remove(key); }
    public int size() { return map.size(); }
    public void clear() { map.clear(); }
    public int keyAt(int index) { return (Integer) map.keySet().toArray()[index]; }
    public boolean valueAt(int index) { return (Boolean) map.values().toArray()[index]; }
    public int indexOfKey(int key) { return map.containsKey(key) ? map.headMap(key).size() : -1; }
    @Override public SparseBooleanArray clone() { SparseBooleanArray c = new SparseBooleanArray(); c.map = new TreeMap<>(map); return c; }
}
