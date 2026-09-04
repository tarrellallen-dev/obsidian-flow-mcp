// Obsidian Flow MCP - AddOn
// Step 2.5: instrument resolution for any asset class, and the identity record that labels
// every frame, every archive row and every backtest report.
//
// Nothing in this file assumes futures. A config entry is one of four shapes:
//   (a) fully qualified NT8 name with a contract month, e.g. "ES 12-26" (example) - used as-is;
//   (b) a root plus a type hint, e.g. "ES:Future" - front contract, and the type NT8 returns
//       must match the hint or the entry is reported unresolved rather than silently wrong;
//   (c) a bare root, e.g. "ES" - front contract of whatever NT8 returns for that name, which
//       for a ticker that is both a future and an equity is not necessarily the one meant;
//   (d) anything else (equities, forex, crypto, indexes, CFDs) - resolved directly.
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

        // Not on the wire. The config entry exactly as written, type hint included - "ES:Future"
        // where ResolvedFrom is "ES". Re-resolution on the roll clock must pass this back in,
        // not ResolvedFrom: a bare "ES" hands back the equity, so an entry that resolved
        // correctly at start would otherwise be re-resolved onto a stock a minute later and
        // reported as a contract roll. ResolvedFrom stays the stripped name because that is what
        // the wire, the archive labels and the server's instrument lookup use.
        public readonly string TypedEntry;

        public InstrumentIdentity(
            string resolvedFrom,
            InstrumentShape shape,
            ResolutionMethod resolvedBy,
            Instrument instrument,
            long rolledAtUtcTicks,
            ushort rollCount)
            : this(resolvedFrom, resolvedFrom, shape, resolvedBy, instrument, rolledAtUtcTicks, rollCount)
        {
        }

        public InstrumentIdentity(
            string typedEntry,
            string resolvedFrom,
            InstrumentShape shape,
            ResolutionMethod resolvedBy,
            Instrument instrument,
            long rolledAtUtcTicks,
            ushort rollCount)
        {
            TypedEntry = typedEntry ?? resolvedFrom ?? "";
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
            return new InstrumentIdentity(TypedEntry, ResolvedFrom, Shape, ResolvedBy, Instrument, utcNow.Ticks, count);
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
        // True when there is no hint to check, or the instrument is of the hinted type. A null
        // instrument passes: the callers treat "not found" separately and report it better.
        private static bool TypeMatches(Instrument candidate, string expectedType, string name, out string error)
        {
            error = null;
            if (expectedType == null || candidate == null || candidate.MasterInstrument == null)
                return true;

            string actual = candidate.MasterInstrument.InstrumentType.ToString();
            if (string.Equals(actual, expectedType, StringComparison.OrdinalIgnoreCase))
                return true;

            error = "\"" + name + "\" resolves to a " + actual + " in NinjaTrader, not a "
                  + expectedType + ", and no " + expectedType + " named \"" + name
                  + "\" is in the instrument database either. Check the type hint, or name the"
                  + " contract in full (for example \"" + name + " 12-26\").";
            return false;
        }

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
        //   0. A trailing ":<type>" is split off first and is not part of any lookup. It is a
        //      hint, checked against whatever the steps below return; a mismatch is reported as
        //      unresolved rather than subscribed to. The unsplit entry is kept on the identity
        //      as TypedEntry so the roll clock can re-resolve with the hint still attached.
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

            string entry = typed.Trim();
            string name = entry;

            // Optional type hint: "ES:Future". NinjaTrader's instrument database contains more
            // than one instrument called ES - the CME E-mini future and an equity with the same
            // ticker - and Instrument.GetInstrument("ES") returns the equity. Without a hint a
            // bare name is whatever NT8 hands back, which is silently the wrong instrument for
            // anyone who meant the future. Observed on 8.1.8.2, 2026-09-04.
            string expectedType = null;
            int colon = name.LastIndexOf(':');
            if (colon > 0 && colon < name.Length - 1)
            {
                expectedType = name.Substring(colon + 1).Trim();
                name = name.Substring(0, colon).Trim();
                if (name.Length == 0)
                {
                    error = "instrument name is empty before the ':' type hint";
                    return null;
                }
            }

            string root;
            bool qualified = HasContractMonth(name, out root);

            try
            {
                // With a type hint on a root, the typed master lookup goes first. Asking
                // GetInstrument by name and then complaining about what came back is how this
                // resolver used to behave, and it turned a correct config entry into an
                // unresolved one: "ES:Future" would report that "ES" is a Stock and stop, with
                // the futures master sitting one typed lookup away the whole time.
                if (expectedType != null && !qualified)
                {
                    // Not root: HasContractMonth leaves it null unless a contract month was typed,
                    // and this branch is the case where none was. name is the root here.
                    MasterInstrument hinted = FindMasterByName(name, expectedType);
                    if (hinted != null)
                    {
                        string hintedWhy;
                        ResolutionMethod hintedMethod;
                        Instrument hintedFront = FrontContract(hinted, now, out hintedMethod, out hintedWhy);
                        if (hintedFront != null)
                            return new InstrumentIdentity(entry, name, InstrumentShape.Root, hintedMethod, hintedFront, rolledAtUtcTicks, rollCount);

                        // A master of the right type with no live contract is a real answer, and a
                        // better one than falling through to a same-named instrument of another
                        // type would be.
                        if (!IsExpiringType(hinted))
                        {
                            Instrument plain = Instrument.GetInstrument(name);
                            if (plain != null && TypeMatches(plain, expectedType, name, out error))
                                return new InstrumentIdentity(entry, name, InstrumentShape.Direct, ResolutionMethod.AsTyped, plain, rolledAtUtcTicks, rollCount);
                        }
                        error = "no live contract for " + name + " as a " + expectedType + " (" + hintedWhy + ")";
                        return null;
                    }
                }

                Instrument direct = Instrument.GetInstrument(name);

                if (!TypeMatches(direct, expectedType, name, out error))
                    return null;

                if (qualified)
                {
                    if (direct == null)
                    {
                        error = "not in the NinjaTrader instrument database: " + name;
                        return null;
                    }
                    return new InstrumentIdentity(entry, name, InstrumentShape.FullyQualified, ResolutionMethod.AsTyped, direct, rolledAtUtcTicks, rollCount);
                }

                if (direct != null && !IsExpiringType(direct.MasterInstrument))
                    return new InstrumentIdentity(entry, name, InstrumentShape.Direct, ResolutionMethod.AsTyped, direct, rolledAtUtcTicks, rollCount);

                if (direct != null && !IsExpired(direct, now))
                    return new InstrumentIdentity(entry, name, InstrumentShape.Root, ResolutionMethod.Nt8Default, direct, rolledAtUtcTicks, rollCount);

                // A root whose NT8 default is missing or expired: consult NT8's own roll data.
                MasterInstrument master = direct != null ? direct.MasterInstrument : FindMasterByName(name, expectedType);
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
                // The hint is checked here as well as on the direct lookup above: this path is
                // reached when GetInstrument returned nothing or an expired contract, and it
                // must not be a way in for an instrument of the wrong type.
                if (!TypeMatches(front, expectedType, name, out error))
                    return null;
                return new InstrumentIdentity(entry, name, InstrumentShape.Root, method, front, rolledAtUtcTicks, rollCount);
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
        // Name plus type to a MasterInstrument, which is the lookup that makes a type hint do
        // something rather than merely complain. Instrument.GetInstrument(name) is name-only, so
        // for a ticker held by more than one instrument - "ES" is both the CME future and an
        // equity in NinjaTrader's own database - it returns whichever one the database hands back
        // and there is no argument to say which was meant. MasterInstrument.DbGet takes the type,
        // so "ES" plus Future reaches the futures master even when GetInstrument("ES") does not.
        //
        // Confirmed against NinjaTrader.Core.dll on 8.1.8.2 (2026-09-04):
        //   public static MasterInstrument DbGet(string, InstrumentType, bool)
        // The third argument is passed false deliberately and is never passed true: its meaning is
        // not documented for NinjaScript, and the plausible readings include creating the record
        // when it is absent. A null result is a normal answer here and is handled by the caller;
        // writing to the owner's instrument database to satisfy a lookup would not be.
        private static MasterInstrument FindMasterByName(string name, string expectedType)
        {
            if (name == null || name.Length == 0 || expectedType == null)
                return null;

            InstrumentType type;
            if (!TryParseInstrumentType(expectedType, out type))
                return null;

            try
            {
                MasterInstrument master = MasterInstrument.DbGet(name, type, false);
                if (master == null)
                    return null;
                // Trust nothing: the row came back from a database lookup, so check it is the
                // thing that was asked for before any of it is used.
                // Safe() belongs to InstrumentIdentity, not to this class. string.Equals handles a
                // null on either side on its own, so nothing is needed here.
                if (!string.Equals(master.Name, name, StringComparison.OrdinalIgnoreCase))
                    return null;
                if (master.InstrumentType != type)
                    return null;
                return master;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static bool TryParseInstrumentType(string text, out InstrumentType type)
        {
            type = InstrumentType.Future;
            if (text == null)
                return false;
            try
            {
                object parsed = Enum.Parse(typeof(InstrumentType), text.Trim(), true);
                if (parsed == null)
                    return false;
                type = (InstrumentType)parsed;
                return true;
            }
            catch (Exception)
            {
                return false;
            }
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
