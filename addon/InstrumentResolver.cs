// Obsidian Flow MCP - AddOn
// Step 2.5: instrument resolution for any asset class, and the identity record that labels
// every frame, every archive row and every backtest report.
//
// Nothing in this file assumes futures. A config entry is one of three shapes:
//   (a) fully qualified NT8 name with a contract month, e.g. "ES 12-26" (example) - used as-is;
//   (b) a bare futures root, e.g. "ES" - resolved to the front contract, re-checked for rolls;
//   (c) anything else (equities, forex, crypto, indexes, CFDs) - resolved directly.
// No contract month is ever derived by arithmetic on today's date: every month string sent to
// Instrument.GetInstrument comes out of NinjaTrader's own rollover table or its own expiry
// calculation. Resolution never throws; failure comes back as a reason string.
//
// All of this runs on the AddOn worker thread at start and on the publisher thread once a
// minute. Never on a data thread.
// .NET Framework 4.8. ASCII only.

using System;
using System.Collections.Generic;
using System.Globalization;
using NinjaTrader.Cbi;
using NinjaTrader.Data;

namespace NinjaTrader.NinjaScript.AddOns.ObsidianFlowOrderFlowMcp
{
    // Which of the three accepted config shapes the entry was. On the wire as u8.
    public enum InstrumentShape : byte
    {
        FullyQualified = 1,     // "ES 12-26" (example): used exactly as typed, never re-resolved
        Root = 2,               // "ES": front contract, re-resolved for rolls
        Direct = 3              // non-futures symbol: resolved as typed, never re-resolved
    }

    // How the resolved name was arrived at. On the wire as u8.
    public enum ResolutionMethod : byte
    {
        AsTyped = 1,            // Instrument.GetInstrument(typed) returned the instrument used
        Nt8Default = 2,         // GetInstrument(root) returned a live contract chosen by NT8
        RolloverTable = 3,      // MasterInstrument.RolloverCollection named the current contract
        NextExpiry = 4          // MasterInstrument.GetNextExpiry named the nearest live contract
    }

    // Immutable fingerprint of one subscribed instrument, produced once at subscribe time
    // (and once more per roll). Every field except Instrument goes into the hello frame and
    // the contractRolled event, and it is what the archive lane labels its rows with.
    public sealed class InstrumentIdentity
    {
        public readonly string ResolvedFrom;        // exactly what the user typed, trimmed
        public readonly InstrumentShape Shape;
        public readonly ResolutionMethod ResolvedBy;
        public readonly string FullName;            // NT8 Instrument.FullName, e.g. "ES 12-26" (example)
        public readonly string MasterName;          // MasterInstrument.Name, e.g. "ES"
        public readonly string InstrumentType;      // MasterInstrument.InstrumentType.ToString()
        public readonly string Exchange;            // Instrument.Exchange.ToString()
        public readonly string Currency;            // MasterInstrument.Currency.ToString()
        public readonly string TradingHours;        // MasterInstrument.TradingHours.Name
        public readonly long ExpiryTicks;           // DateTime.Ticks of the expiry date; 0 = does not expire
        public readonly double TickSize;
        public readonly double PointValue;
        public readonly long RolledAtUtcTicks;      // DateTime.UtcNow.Ticks of the last roll; 0 = never
        public readonly ushort RollCount;           // rolls in this AddOn process for this config entry

        // Not on the wire. The live NT8 object the feed subscribes with.
        public readonly Instrument Instrument;

        public InstrumentIdentity(
            string resolvedFrom,
            InstrumentShape shape,
            ResolutionMethod resolvedBy,
            Instrument instrument,
            long rolledAtUtcTicks,
            ushort rollCount)
        {
            ResolvedFrom = resolvedFrom ?? "";
            Shape = shape;
            ResolvedBy = resolvedBy;
            Instrument = instrument;
            RolledAtUtcTicks = rolledAtUtcTicks;
            RollCount = rollCount;

            MasterInstrument master = instrument != null ? instrument.MasterInstrument : null;

            FullName = instrument != null ? Safe(instrument.FullName) : "";
            MasterName = master != null ? Safe(master.Name) : "";
            InstrumentType = master != null ? master.InstrumentType.ToString() : "";
            Exchange = instrument != null ? instrument.Exchange.ToString() : "";
            Currency = master != null ? master.Currency.ToString() : "";
            TradingHours = master != null && master.TradingHours != null ? Safe(master.TradingHours.Name) : "";
            ExpiryTicks = InstrumentResolver.ExpiryTicks(instrument);
            TickSize = master != null ? master.TickSize : 0.0;
            PointValue = master != null ? master.PointValue : 0.0;
        }

        // Same contract: the only comparison a roll check needs.
        public bool SameContract(InstrumentIdentity other)
        {
            return other != null && string.Equals(FullName, other.FullName, StringComparison.Ordinal);
        }

        public bool Expires { get { return ExpiryTicks != 0; } }

        public bool IsExpiredAt(DateTime now)
        {
            return ExpiryTicks != 0 && ExpiryTicks <= now.Ticks;
        }

        // A copy of this identity re-labelled as the result of a roll away from previous.
        public InstrumentIdentity AsRolledFrom(InstrumentIdentity previous, DateTime utcNow)
        {
            ushort count = previous == null ? (ushort)1 : (ushort)(previous.RollCount + 1);
            return new InstrumentIdentity(ResolvedFrom, Shape, ResolvedBy, Instrument, utcNow.Ticks, count);
        }

        public string ExpiryText()
        {
            if (ExpiryTicks == 0)
                return "none";
            return new DateTime(ExpiryTicks).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }

        private static string Safe(string s)
        {
            return s ?? "";
        }
    }

    // A config entry that produced no subscription. Reported, never thrown.
    public sealed class UnresolvedInstrument
    {
        public readonly string Typed;
        public readonly string Reason;

        public UnresolvedInstrument(string typed, string reason)
        {
            Typed = typed ?? "";
            Reason = reason ?? "";
        }
    }

    public static class InstrumentResolver
    {
        // Instruments whose master is one of these types expire. Everything else (Stock, Index,
        // Forex, CryptoCurrency, Cfd, ...) reports expiry 0 and is never re-resolved.
        private static bool IsExpiringType(MasterInstrument master)
        {
            if (master == null)
                return false;
            return master.InstrumentType == NinjaTrader.Cbi.InstrumentType.Future
                || master.InstrumentType == NinjaTrader.Cbi.InstrumentType.Option;
        }

        // Ticks of the expiry date, 0 when the instrument does not expire. NT8 reports a far
        // future sentinel date for non-expiring instruments; the type check is what decides,
        // and the year guard is a belt for the case the type is Future but the sentinel is set.
        public static long ExpiryTicks(Instrument instrument)
        {
            if (instrument == null || !IsExpiringType(instrument.MasterInstrument))
                return 0;
            DateTime expiry = instrument.Expiry;
            if (expiry == DateTime.MaxValue || expiry == DateTime.MinValue || expiry.Year >= 2099)
                return 0;
            return expiry.Ticks;
        }

        public static bool IsExpired(Instrument instrument, DateTime now)
        {
            long ticks = ExpiryTicks(instrument);
            return ticks != 0 && ticks <= now.Ticks;
        }

        // Recognises the NT8 "<root> MM-YY" form: everything before the last space is the root,
        // the tail is two digits, a dash, two digits. No date arithmetic; this only classifies
        // what the user typed.
        public static bool HasContractMonth(string typed, out string root)
        {
            root = null;
            if (string.IsNullOrEmpty(typed))
                return false;

            int space = typed.LastIndexOf(' ');
            if (space <= 0 || space + 6 != typed.Length)
                return false;

            string tail = typed.Substring(space + 1);
            if (tail.Length != 5 || tail[2] != '-')
                return false;
            for (int i = 0; i < 5; i++)
            {
                if (i == 2)
                    continue;
                if (tail[i] < '0' || tail[i] > '9')
                    return false;
            }

            root = typed.Substring(0, space);
            return true;
        }

        // The contract-month suffix NT8 uses in instrument names, formatted from a date NT8
        // itself supplied (a rollover table entry or an expiry). Invariant culture.
        public static string ContractMonthSuffix(DateTime contractMonth)
        {
            return contractMonth.ToString("MM-yy", CultureInfo.InvariantCulture);
        }

        // Resolves one config entry. Returns null with a reason on failure; never throws.
        //
        // Resolution order:
        //   1. Instrument.GetInstrument(typed).
        //      - typed carries a contract month: shape (a), used as-is even if expired (the
        //        user asked for that contract; the expiry is reported so it is visible).
        //      - the result is not an expiring type: shape (c), used as-is.
        //      - the result is an expiring type that has not expired: shape (b), NT8 picked the
        //        contract for the root (ResolutionMethod.Nt8Default).
        //   2. Otherwise typed is a root with no live contract from step 1. Take the master
        //      (from the expired result, or by name) and ask NT8's own rollover table which
        //      contract month it is currently on; verify that contract exists and is live.
        //   3. Otherwise MasterInstrument.GetNextExpiry(now): the nearest expiry strictly after
        //      now, by NT8's calculation; verify it exists and is live.
        //   4. Otherwise unresolved, with the reason.
        public static InstrumentIdentity Resolve(string typed, DateTime now, out string error)
        {
            return Resolve(typed, now, 0L, 0, out error);
        }

        public static InstrumentIdentity Resolve(string typed, DateTime now, long rolledAtUtcTicks, ushort rollCount, out string error)
        {
            error = null;
            if (typed == null || typed.Trim().Length == 0)
            {
                error = "empty instrument name";
                return null;
            }

            string name = typed.Trim();
            string root;
            bool qualified = HasContractMonth(name, out root);

            try
            {
                Instrument direct = Instrument.GetInstrument(name);

                if (qualified)
                {
                    if (direct == null)
                    {
                        error = "not in the NinjaTrader instrument database: " + name;
                        return null;
                    }
                    return new InstrumentIdentity(name, InstrumentShape.FullyQualified, ResolutionMethod.AsTyped, direct, rolledAtUtcTicks, rollCount);
                }

                if (direct != null && !IsExpiringType(direct.MasterInstrument))
                    return new InstrumentIdentity(name, InstrumentShape.Direct, ResolutionMethod.AsTyped, direct, rolledAtUtcTicks, rollCount);

                if (direct != null && !IsExpired(direct, now))
                    return new InstrumentIdentity(name, InstrumentShape.Root, ResolutionMethod.Nt8Default, direct, rolledAtUtcTicks, rollCount);

                // A root whose NT8 default is missing or expired: consult NT8's own roll data.
                MasterInstrument master = direct != null ? direct.MasterInstrument : FindMasterByName(name);
                if (master == null)
                {
                    error = "not in the NinjaTrader instrument database: " + name;
                    return null;
                }

                string why;
                ResolutionMethod method;
                Instrument front = FrontContract(master, now, out method, out why);
                if (front == null)
                {
                    error = "no live contract for root " + name + " (" + why + ")";
                    return null;
                }
                return new InstrumentIdentity(name, InstrumentShape.Root, method, front, rolledAtUtcTicks, rollCount);
            }
            catch (Exception ex)
            {
                error = ex.GetType().Name + ": " + ex.Message;
                return null;
            }
        }

        // Master lookup by name when GetInstrument(root) returned nothing at all.
        // NT8 8.1.8.2 has no MasterInstrument.DbGet(string) - the overload takes a database id
        // (CS1503 on 2026-09-03), so there is no name lookup here. Step 1 of Resolve already
        // covers every root NT8 can resolve itself, and an unresolvable root is reported with a
        // reason rather than guessed at.
        private static MasterInstrument FindMasterByName(string name)
        {
            return null;
        }

        // NT8's rollover table first (its own roll settings: the latest rollover whose date has
        // passed names the contract NT8 is currently on, and later entries name the ones after
        // it), then GetNextExpiry as the nearest-non-expired fallback. Each candidate is checked
        // to exist and to expire strictly after now.
        // VERIFY ON COMPILE: MasterInstrument.RolloverCollection (List<Rollover>), Rollover.Date,
        // Rollover.ContractMonth, MasterInstrument.GetNextExpiry(DateTime).
        private static Instrument FrontContract(MasterInstrument master, DateTime now, out ResolutionMethod method, out string why)
        {
            method = ResolutionMethod.RolloverTable;
            why = "";

            List<DateTime> candidates = new List<DateTime>(4);
            try
            {
                Rollover current = null;
                List<Rollover> later = new List<Rollover>();
                // RolloverCollection is NT8's own collection type, not a List<Rollover>, so it is
                // enumerated rather than indexed.
                RolloverCollection rollovers = master.RolloverCollection;
                if (rollovers != null)
                {
                    foreach (Rollover r in rollovers)
                    {
                        if (r == null)
                            continue;
                        if (r.Date <= now)
                        {
                            if (current == null || r.Date > current.Date)
                                current = r;
                        }
                        else
                        {
                            later.Add(r);
                        }
                    }
                }
                later.Sort(delegate (Rollover a, Rollover b) { return a.Date.CompareTo(b.Date); });

                if (current != null)
                    candidates.Add(current.ContractMonth);
                for (int i = 0; i < later.Count && candidates.Count < 4; i++)
                    candidates.Add(later[i].ContractMonth);
            }
            catch (Exception ex)
            {
                why = "rollover table: " + ex.Message;
            }

            for (int i = 0; i < candidates.Count; i++)
            {
                Instrument c = TryContract(master, candidates[i], now);
                if (c != null)
                    return c;
            }

            method = ResolutionMethod.NextExpiry;
            try
            {
                DateTime next = master.GetNextExpiry(now);
                Instrument c = TryContract(master, next, now);
                if (c != null)
                    return c;
                if (why.Length == 0)
                    why = "rollover table and next expiry " + ContractMonthSuffix(next) + " gave no live contract";
            }
            catch (Exception ex)
            {
                if (why.Length > 0)
                    why = why + "; ";
                why = why + "next expiry: " + ex.Message;
            }

            if (why.Length == 0)
                why = "rollover table has no entry naming a live contract";
            return null;
        }

        private static Instrument TryContract(MasterInstrument master, DateTime contractMonth, DateTime now)
        {
            if (contractMonth == DateTime.MinValue || contractMonth == DateTime.MaxValue)
                return null;
            string candidate = master.Name + " " + ContractMonthSuffix(contractMonth);
            Instrument c = Instrument.GetInstrument(candidate);
            if (c == null || IsExpired(c, now))
                return null;
            return c;
        }

        // Local-clock ticks of the end of the trading session the instrument is in (or the
        // next one), from its trading-hours template. 0 when unavailable; the once-a-minute
        // roll check still runs in that case, only the session-boundary trigger is lost.
        // NT8 8.1.8.2's TradingHours has no GetNextBeginEnd (CS1061 on 2026-09-03), so there is
        // no session-boundary trigger for the roll check. Returning 0 means "no boundary known",
        // which leaves the once-a-minute re-resolve as the only trigger - later by up to a
        // minute, never wrong. Session start and end for the profile come from the bars series,
        // not from here.
        public static long NextSessionEndTicks(Instrument instrument, DateTime now)
        {
            return 0;
        }
    }
}
