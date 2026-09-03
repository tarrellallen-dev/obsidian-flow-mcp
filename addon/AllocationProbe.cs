// ObsidianFlow Order-Flow MCP - AddOn
// Reads the per-thread allocation counter. Spec 2.4 and docs/decisions/0002-no-gc-tampering.md:
// this reads a counter and changes no GC setting anywhere.
// .NET Framework 4.8. ASCII only.

using System;
using System.Reflection;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    public static class AllocationProbe
    {
        // Declaration order matters: static initializers run top to bottom.
        private static readonly Func<long> ZeroProbe = Zero;
        private static readonly Func<long> Probe = Resolve();

        // True when the host runtime exposes GC.GetAllocatedBytesForCurrentThread. When false,
        // Read() returns 0 and every allocation figure downstream must be reported as absent
        // rather than as zero bytes.
        public static bool IsAvailable
        {
            get { return !ReferenceEquals(Probe, ZeroProbe); }
        }

        // Allocated bytes on the calling thread. Never throws.
        public static long Read()
        {
            return Probe();
        }

        // Resolved by reflection once, at type initialization, so the AddOn compiles and runs
        // regardless of which .NET Framework servicing level the host exposes this method at.
        private static Func<long> Resolve()
        {
            try
            {
                MethodInfo mi = typeof(GC).GetMethod(
                    "GetAllocatedBytesForCurrentThread",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static,
                    null,
                    Type.EmptyTypes,
                    null);

                if (mi != null && mi.ReturnType == typeof(long))
                    return (Func<long>)Delegate.CreateDelegate(typeof(Func<long>), mi);
            }
            catch (Exception)
            {
            }

            return ZeroProbe;
        }

        private static long Zero()
        {
            return 0L;
        }
    }
}
