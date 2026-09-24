using Interop.UIAutomationClient;
namespace Dtf;
static class Spike {
  public static void Run() {
    var uia = new CUIAutomation8();
    var root = uia.GetRootElement();
    Console.Error.WriteLine($"root: {root.CurrentName} ct={root.CurrentControlType}");
    var cond = uia.CreateTrueCondition();
    var kids = root.FindAll(TreeScope.TreeScope_Children, cond);
    Console.Error.WriteLine($"children: {kids.Length}");
    for (int i = 0; i < Math.Min(kids.Length, 8); i++) {
      var k = kids.GetElement(i);
      Console.Error.WriteLine($"  {k.CurrentName} [{k.CurrentClassName}] pid={k.CurrentProcessId}");
    }
  }
}
