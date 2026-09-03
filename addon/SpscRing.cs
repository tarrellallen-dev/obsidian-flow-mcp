// ObsidianFlow Order-Flow MCP - AddOn
// Spec section 3.1: the single ring protocol. Single producer, single consumer.
// .NET Framework 4.8. ASCII only.

using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    // Power-of-two capacity C. 64-bit monotone head (producer owned) and tail (consumer owned).
    // Slots indexed by index & (C - 1).
    //
    // Producer (NT data thread):
    //   if (head - Volatile.Read(ref tail) == C) { Interlocked.Increment(ref dropped); return false; }
    //   write slot; Volatile.Write(ref head, head + 1);
    //
    // Consumer (publisher thread):
    //   h = Volatile.Read(ref head); read slots tail..h; Volatile.Write(ref tail, h);
    //
    // Full = drop newest. The frame is a conflated snapshot anyway. 64-bit indices do not roll
    // over in practice (2^63 events); this is stated rather than handled.
    //
    // Push allocates nothing: the slot array is preallocated and written by ref.
    [StructLayout(LayoutKind.Sequential)]
    public sealed class SpscRing
    {
        private readonly MdEvent[] _slots;
        private readonly long _capacity;
        private readonly long _mask;

        // Producer-owned and consumer-owned indices are padded onto separate 64-byte cache lines
        // so the producer's store to _head never invalidates the line the consumer is writing
        // _tail into. The padding fields are never read; they exist purely for the layout.
        // LayoutKind.Sequential on the class keeps the CLR from reordering them away.

#pragma warning disable 0169
        private long _padA0, _padA1, _padA2, _padA3, _padA4, _padA5, _padA6, _padA7;
#pragma warning restore 0169

        // Producer owned. Written only by the producer thread.
        private long _head;

        // Producer increments, consumer clears with Interlocked.Exchange. Producer-side line.
        private long _dropped;

#pragma warning disable 0169
        private long _padB0, _padB1, _padB2, _padB3, _padB4, _padB5;
#pragma warning restore 0169

        // Consumer owned. Written only by the consumer thread.
        private long _tail;

#pragma warning disable 0169
        private long _padC0, _padC1, _padC2, _padC3, _padC4, _padC5, _padC6;
#pragma warning restore 0169

        public SpscRing(int capacity)
        {
            if (capacity < 2)
                throw new ArgumentOutOfRangeException("capacity", "capacity must be >= 2");
            if ((capacity & (capacity - 1)) != 0)
                throw new ArgumentException("capacity must be a power of two", "capacity");

            _slots = new MdEvent[capacity];
            _capacity = capacity;
            _mask = capacity - 1;
            _head = 0;
            _tail = 0;
            _dropped = 0;
        }

        public int Capacity { get { return (int)_capacity; } }

        // Producer side. Called from the NT data thread. Zero allocation.
        // Returns false when the ring is full and the event was dropped.
        public bool Push(ref MdEvent ev)
        {
            long head = _head;
            if (head - Volatile.Read(ref _tail) == _capacity)
            {
                Interlocked.Increment(ref _dropped);
                return false;
            }

            _slots[head & _mask] = ev;
            Volatile.Write(ref _head, head + 1);
            return true;
        }

        // Consumer side. Returns the number of slots actually consumed.
        //
        // When destination is null the contents are discarded and everything published up to the
        // observed head is consumed in one step. When destination is non-null at most
        // destination.Length slots are copied and _tail advances by exactly that many, so the
        // remainder stays in the ring for the next call and is never silently lost. Callers that
        // want the ring emptied loop until Drain returns 0.
        public int Drain(MdEvent[] destination)
        {
            long tail = _tail;
            long head = Volatile.Read(ref _head);
            long available = head - tail;
            if (available <= 0)
                return 0;

            long take = available;
            if (destination != null)
            {
                if (take > destination.Length)
                    take = destination.Length;
                for (long i = 0; i < take; i++)
                    destination[i] = _slots[(tail + i) & _mask];
            }

            Volatile.Write(ref _tail, tail + take);
            return (int)take;
        }

        // Consumer side. Reads and clears the drop counter atomically.
        public long ExchangeDropped()
        {
            return Interlocked.Exchange(ref _dropped, 0);
        }

        // Observation only (status window). Not part of the protocol.
        public long DroppedPeek()
        {
            return Interlocked.Read(ref _dropped);
        }

        public long HeadPeek()
        {
            return Volatile.Read(ref _head);
        }
    }
}
